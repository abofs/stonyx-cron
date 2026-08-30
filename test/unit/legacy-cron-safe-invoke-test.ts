/**
 * Unit tests — legacy `Cron` safe callback invocation (#36).
 *
 * Two defects in `src/main.ts`, one root cause: the legacy class has no safe
 * way to invoke a consumer callback.
 *
 *   D1 — `runDueJobs` awaits the callback inside the drain loop, so a callback
 *        that never settles starves every other job and stops the timer from
 *        re-arming (while `this.timer` stays non-null, a false liveness signal).
 *   D2 — `register(runOnInit)` invokes the callback without `await` inside a
 *        `try`/`catch`, so an async rejection escapes the catch entirely and
 *        terminates the process under Node's default `--unhandled-rejections=throw`.
 *
 * Harness notes (from refinement):
 *   - `Cron` is a singleton with no reset; `Cron.instance = null` in beforeEach.
 *   - Every heap assertion is scoped by `key`. `heap.items.length` is not
 *     writable here because the suite shares one heap.
 *   - The clock must be advanced far enough that `scheduleNextRun`'s `setTimeout`
 *     fires naturally. Calling `runDueJobs()` directly skips `scheduleNextRun`
 *     and proves nothing.
 *   - Assertion 3 needs a `process.on('unhandledRejection')` capture or it kills
 *     the runner instead of failing.
 */
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import log from 'stonyx/log';
import Cron from '../../src/main.js';

const { module, test } = QUnit;

// Captured before any fake timer is installed so we can yield a *real* macrotask
// turn — that is what lets Node emit `unhandledRejection`.
const realSetImmediate = setImmediate;
function realTick(): Promise<void> {
  return new Promise<void>(resolve => { realSetImmediate(resolve); });
}

module('[Unit] Legacy Cron — safe invoke (#36)', function (hooks) {
  let cron: Cron;
  let clock: SinonFakeTimers;
  let rejections: unknown[];

  const captureRejection = (reason: unknown) => { rejections.push(reason); };

  hooks.beforeEach(function () {
    rejections = [];
    // Installing a listener also flips Node off `--unhandled-rejections=throw`,
    // so a regressed assertion 3 fails cleanly instead of killing the runner.
    process.on('unhandledRejection', captureRejection);

    Cron.instance = null;
    cron = new Cron();
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false, now: new Date('2026-06-15T12:00:00Z') });
  });

  hooks.afterEach(function () {
    Object.keys(cron.jobs).forEach(key => cron.unregister(key));
    if (cron.timer) clearTimeout(cron.timer);
    clock.restore();
    sinon.restore();
    Cron.instance = null;
    process.off('unhandledRejection', captureRejection);
  });

  module('AC1 — a never-settling job does not starve the scheduler', function () {
    // Validation assertion 1
    test('other jobs keep firing while one job hangs', async function (assert) {
      const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));
      const probe = sinon.spy();

      cron.register('hang', hang, '1');
      cron.register('probe', probe, '2');

      await clock.tickAsync(6000);

      // Precondition — the test cannot pass by never having driven anything due.
      assert.strictEqual(hang.callCount, 1, 'precondition: hung job was invoked exactly once');
      assert.ok(probe.callCount >= 2, `unrelated job kept firing on schedule (fired ${probe.callCount}x, expected >= 2)`);
    });

    // Validation assertion 2 — pins the invariant, not just the symptom. A fix
    // that re-arms the timer without restoring the heap entry still fails here.
    test('hung job stays in the heap and the timer stays armed', async function (assert) {
      const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));
      const probe = sinon.spy();

      cron.register('hang', hang, '1');
      cron.register('probe', probe, '2');

      await clock.tickAsync(6000);

      assert.true(
        cron.heap.items.some(item => item.key === 'hang'),
        'hung job is still present in the heap (key-scoped)',
      );
      assert.notStrictEqual(cron.timer, null, 'timer is still armed');
    });
  });

  module('AC2 — runOnInit rejection is caught, not fatal', function () {
    // Validation assertion 3
    test('async rejecting runOnInit callback logs and produces no unhandled rejection', async function (assert) {
      const errorSpy = sinon.stub(log, 'error');

      cron.register('boom', async () => { throw new Error('async boom'); }, '300', true);

      await clock.tickAsync(0);
      await realTick();

      assert.strictEqual(rejections.length, 0, 'no unhandled rejection escaped register()');
      assert.true(
        errorSpy.calledWithMatch(sinon.match(/Cron job "boom" failed on init/)),
        'log.error received the failed-on-init message',
      );
    });

    // Validation assertion 4 — preservation guard. Guards against a fix that
    // handles the async case by dropping the synchronous one.
    test('synchronous throwing runOnInit callback still logs and still schedules', async function (assert) {
      const errorSpy = sinon.stub(log, 'error');

      cron.register('syncboom', () => { throw new Error('sync boom'); }, '300', true);

      await clock.tickAsync(0);

      assert.true(
        errorSpy.calledWithMatch(sinon.match(/Cron job "syncboom" failed on init/)),
        'log.error received the failed-on-init message for the synchronous throw',
      );
      assert.true(
        cron.heap.items.some(item => item.key === 'syncboom'),
        'job remains scheduled in the heap after a synchronous init throw (key-scoped)',
      );
    });
  });

  module('AC3 — same-job overlap is prevented (regression guard)', function () {
    // Validation assertion 5 — REGRESSION GUARD, not a defect test.
    //
    // Same-job overlap is structurally impossible against `dev`: the drain loop
    // awaits the callback, so a slow job simply blocks everything (the call-count
    // half of this assertion therefore passes vacuously against `dev`). This
    // assertion guards a hazard the *fix* introduces, and is mutation-proven
    // against removal of the in-flight flag rather than against `dev`.
    test('a job still running when next due is skipped and logged', async function (assert) {
      const warnSpy = sinon.stub(log, 'warn');
      let settle: (() => void) | undefined;
      const slow = sinon.stub().callsFake(() => new Promise<void>(resolve => { settle = resolve; }));

      cron.register('slow', slow, '1');

      await clock.tickAsync(3000);

      assert.strictEqual(slow.callCount, 1, 'slow job invoked exactly once across 3 due ticks — no overlap');
      assert.true(
        warnSpy.calledWithMatch(sinon.match(/still running/)),
        'a still-running skip was logged for the ticks that were passed over',
      );

      settle?.();
      await clock.tickAsync(0);
    });
  });
});
