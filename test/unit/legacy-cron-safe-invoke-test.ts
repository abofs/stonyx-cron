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
import Cron from '../../src/main.js';

const { module, skip } = QUnit;

module('[Unit] Legacy Cron — safe invoke (#36)', function (hooks) {
  let cron: Cron;
  let clock: SinonFakeTimers;

  hooks.beforeEach(function () {
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
  });

  module('AC1 — a never-settling job does not starve the scheduler', function () {
    // Validation assertion 1
    skip('TODO: other jobs keep firing while one job hangs', function (assert) {
      assert.ok(false, 'not implemented');
    });

    // Validation assertion 2
    skip('TODO: hung job stays in the heap and the timer stays armed', function (assert) {
      assert.ok(false, 'not implemented');
    });
  });

  module('AC2 — runOnInit rejection is caught, not fatal', function () {
    // Validation assertion 3
    skip('TODO: async rejecting runOnInit callback logs and produces no unhandled rejection', function (assert) {
      assert.ok(false, 'not implemented');
    });

    // Validation assertion 4
    skip('TODO: synchronous throwing runOnInit callback still logs and still schedules', function (assert) {
      assert.ok(false, 'not implemented');
    });
  });

  module('AC3 — same-job overlap is prevented (regression guard)', function () {
    // Validation assertion 5 — REGRESSION GUARD, not a defect test.
    // Same-job overlap is structurally impossible against `dev` (the drain loop
    // blocks). This guards a hazard the fix itself introduces, and is
    // mutation-proven against removal of the in-flight flag.
    skip('TODO: a job still running when next due is skipped and logged', function (assert) {
      assert.ok(false, 'not implemented');
    });
  });
});
