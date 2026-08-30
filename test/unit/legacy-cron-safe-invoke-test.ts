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
import { getTimestamp } from '@stonyx/utils/date';
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

  hooks.afterEach(function (assert) {
    // The `unhandledRejection` capture installed above also flips this module
    // off `--unhandled-rejections=throw`, which would otherwise let the four
    // tests that do not assert on `rejections` swallow one silently.
    assert.strictEqual(rejections.length, 0, 'no unhandled rejection escaped this test');

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
      sinon.stub(log, 'warn');
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
      sinon.stub(log, 'warn');
      const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));
      const probe = sinon.spy();

      cron.register('hang', hang, '1');
      cron.register('probe', probe, '2');

      await clock.tickAsync(6000);

      assert.true(
        cron.heap.items.some(item => item.key === 'hang'),
        'hung job is still present in the heap (key-scoped)',
      );
      // NOT A DISCRIMINATOR: `scheduleNextRun` never nulls `this.timer`, so this
      // is non-null against `dev` too — that is the false-liveness finding, not
      // evidence of health. The key-scoped heap assertion above is the only half
      // of this test that discriminates.
      assert.notStrictEqual(cron.timer, null, 'timer is non-null (does not discriminate — see the heap assertion above)');
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

      // Heap membership is not liveness. Under a missing release on the
      // synchronous-throw path the job stays in `jobs`, stays in the heap and
      // keeps the timer armed while never running again — the same
      // false-liveness signature the refinement flagged for the original
      // defect, and strictly worse than `dev`, where a sync-throwing job keeps
      // firing. The two assertions below are the ones that discriminate.
      await clock.tickAsync(300_000);
      assert.strictEqual(errorSpy.callCount, 2, 'the job ran again on its next tick after throwing');
      assert.strictEqual(
        cron.jobs['syncboom']?.runningAtMs,
        undefined,
        'the guard was released by the synchronous catch',
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
  module('SME BLOCKER 1 — the drain loop must always terminate', function () {
    // `runDueJobs` no longer awaits the callback, so `next.nextTrigger > now` is
    // the loop's ONLY exit condition and its only suspension point is gone. These
    // pin the arithmetic that guarantees termination.
    //
    // Note on form: an end-to-end "does it spin?" test cannot be written so that
    // it FAILS against the current head — a spinning `runDueJobs` wedges the
    // runner rather than failing an assertion. The invariant is therefore
    // asserted directly on `setNextTrigger`, which does fail cleanly.
    test('setNextTrigger always advances the trigger strictly past now', function (assert) {
      const intervals = ['*/5 * * * *', 'abc', '', '0', '-5'];

      intervals.forEach(interval => {
        const job = { callback() {}, interval, key: `iv:${interval}`, nextTrigger: 0 };

        cron.setNextTrigger(job);

        assert.true(
          job.nextTrigger > getTimestamp(),
          `interval ${JSON.stringify(interval)} yields a trigger strictly in the future (got ${job.nextTrigger}, now ${getTimestamp()})`,
        );
      });
    });

    test('register rejects an interval it cannot parse as whole seconds', function (assert) {
      const callback = sinon.spy();

      assert.throws(
        () => cron.register('cronexpr', callback, '*/5 * * * *'),
        /interval/i,
        'register threw on a cron expression instead of scheduling NaN',
      );
      assert.notOk(cron.jobs['cronexpr'], 'the job was not registered');
      assert.false(cron.heap.items.some(item => item.key === 'cronexpr'), 'nothing was pushed onto the heap (key-scoped)');
      assert.strictEqual(callback.callCount, 0, 'the callback was never invoked');
    });

    // GUARD — passes by construction once the floor exists, and cannot be shown
    // failing against the current head because the head spins here rather than
    // failing (measured out-of-suite: 5,180,703 log lines / exit 137). Kept as a
    // bounded end-to-end pin that a degenerate interval still schedules normally.
    test('a zero interval is clamped to the 1s floor and schedules normally', async function (assert) {
      sinon.stub(log, 'warn');
      const callback = sinon.spy();

      cron.register('zero', callback, '0');

      await clock.tickAsync(3000);

      assert.strictEqual(callback.callCount, 3, 'fired once per second rather than spinning');
    });
  });

  module('CTO HIGH — a partially-numeric interval must be rejected, not truncated', function () {
    // `parseInt` stops at the first non-numeric character, so it fails in the
    // dangerous direction: `'1h'` becomes 1, `'30s'` becomes 30, `'5m'` becomes 5.
    // The NaN check catches a cron expression but not these — and these are the
    // likelier consumer typo. `stonyx-orm` reads `DB_SAVE_INTERVAL` from the
    // environment as a string and hands it straight to `register`, so
    // `DB_SAVE_INTERVAL=1h` yields a one-second autosave loop against the disk:
    // a 3600x speed-up with no error attached to it. `Number()` rejects the whole
    // value instead of silently truncating it.
    test('register rejects an interval with a trailing unit instead of truncating it', function (assert) {
      // key -> the interval the truncating parse would have silently produced
      const cases: Array<[string, number]> = [['1h', 1], ['30s', 30], ['5m', 5], ['60 seconds', 60]];

      cases.forEach(([interval, truncated]) => {
        const callback = sinon.spy();

        assert.throws(
          () => cron.register(`unit:${interval}`, callback, interval),
          /interval/i,
          `register threw on ${JSON.stringify(interval)} rather than scheduling it every ${truncated}s`,
        );
        assert.notOk(cron.jobs[`unit:${interval}`], `${JSON.stringify(interval)} was not registered`);
        assert.false(
          cron.heap.items.some(item => item.key === `unit:${interval}`),
          `${JSON.stringify(interval)} was not pushed onto the heap (key-scoped)`,
        );
        assert.strictEqual(callback.callCount, 0, `the ${JSON.stringify(interval)} callback was never invoked`);
      });
    });

    // The opposite direction of the same defect: `parseInt('1e3')` is 1, so an
    // exponent-notation interval runs 1000x faster than written rather than
    // being rejected. `Number()` reads the whole value.
    test('an exponent-notation interval resolves to its full value', function (assert) {
      cron.register('exp', sinon.spy(), '1e3');

      assert.strictEqual(
        cron.jobs['exp']?.nextTrigger,
        getTimestamp() + 1000,
        "'1e3' scheduled 1000s out, not 1s out",
      );
    });

    test('a padded numeric interval is accepted at its full value', function (assert) {
      cron.register('padded', sinon.spy(), ' 60 ');

      assert.strictEqual(
        cron.jobs['padded']?.nextTrigger,
        getTimestamp() + 60,
        "' 60 ' scheduled 60s out",
      );
    });

    // POLICY PIN — the throw/clamp split is unchanged by the parsing swap.
    // Interpretable-but-degenerate values still clamp with one warning; values
    // that carry no whole-second reading at all still throw.
    test('degenerate but interpretable intervals still clamp with a warning rather than throwing', function (assert) {
      const warnSpy = sinon.stub(log, 'warn');

      ['0', '-5'].forEach(interval => {
        cron.register(`degenerate:${interval}`, sinon.spy(), interval);

        assert.strictEqual(
          cron.jobs[`degenerate:${interval}`]?.nextTrigger,
          getTimestamp() + 1,
          `interval ${JSON.stringify(interval)} was clamped to the 1s floor rather than rejected`,
        );
        assert.true(
          warnSpy.calledWithMatch(sinon.match(new RegExp(`clamping to 1s`))),
          `interval ${JSON.stringify(interval)} logged a clamp warning`,
        );
      });

      ['', '   ', 'abc', '*/5 * * * *'].forEach(interval => {
        assert.throws(
          () => cron.register(`unparseable:${interval}`, sinon.spy(), interval),
          /interval/i,
          `interval ${JSON.stringify(interval)} still throws`,
        );
      });
    });
  });

  module('SME BLOCKER 2 — the in-flight guard is released on the async path', function () {
    // GUARD — passes against the current head. The head *has* a release; nothing
    // proved it, which is the finding. Mutation-proven below rather than against
    // `dev`: deleting the release leaves the pre-fix suite at 146 pass / 0 fail.
    test('an async job that settles fires again on its next tick', async function (assert) {
      const callback = sinon.stub().callsFake(async () => {});

      cron.register('asave', callback, '1');

      await clock.tickAsync(1100);
      assert.strictEqual(callback.callCount, 1, 'precondition: fired once');

      await clock.tickAsync(1100);
      assert.strictEqual(callback.callCount, 2, 'async job fired again after its first invocation settled');
      assert.strictEqual(cron.jobs['asave']?.runningAtMs, undefined, 'the in-flight flag was released after the invocation settled');
    });
  });

  module('SME HIGH 3 — an invocation can only release its own guard', function () {
    // The measured bypass: `unregister` clears the key, a replacement starts, and
    // then the ABANDONED invocation settles and clears the flag the replacement
    // owns — letting a third invocation start with no further unregister.
    test('a settling abandoned invocation cannot release a re-registered job', async function (assert) {
      sinon.stub(log, 'warn');
      let settleFirst: (() => void) | undefined;
      const first = sinon.stub().callsFake(() => new Promise<void>(resolve => { settleFirst = resolve; }));
      const second = sinon.stub().callsFake(() => new Promise<void>(() => {}));

      cron.register('save', first, '1');
      await clock.tickAsync(1100);
      assert.strictEqual(first.callCount, 1, 'precondition: the first invocation is in flight');

      cron.unregister('save');
      cron.register('save', second, '1');
      await clock.tickAsync(1100);
      assert.strictEqual(second.callCount, 1, 'precondition: the replacement is in flight');

      // The abandoned invocation settles. Its release must not touch the
      // replacement's guard.
      settleFirst?.();
      await clock.tickAsync(0);

      await clock.tickAsync(1100);
      assert.strictEqual(second.callCount, 1, 'the replacement was not re-invoked by a stale release');
      assert.ok(cron.jobs['save']?.runningAtMs, 'the replacement still holds its own in-flight guard');
    });

    // GUARD — passes against the current head (which clears `inFlight` in
    // `unregister`). Pins the behaviour the head only claims in its PR body and
    // no test covered; mutation-proven below.
    test('unregister releases the key so a re-registered job runs again', async function (assert) {
      sinon.stub(log, 'warn');
      const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));

      cron.register('h', hang, '1');
      await clock.tickAsync(1100);
      assert.ok(cron.jobs['h']?.runningAtMs, 'precondition: the key has an invocation in flight');

      cron.unregister('h');
      assert.notOk(cron.jobs['h'], 'unregister dropped the job that held the guard');

      const fresh = sinon.spy();
      cron.register('h', fresh, '1');
      await clock.tickAsync(1100);

      assert.strictEqual(fresh.callCount, 1, 're-registered key runs again while the abandoned invocation is still pending');
    });
  });

  module('SME HIGH 4 — the error-reporting path cannot kill the process', function () {
    test('the error is logged as message text, not passed into the logToFile slot', async function (assert) {
      const errorSpy = sinon.stub(log, 'error');

      cron.register('detail', async () => { throw new Error('async boom'); }, '300', true);

      await clock.tickAsync(0);
      await realTick();

      assert.strictEqual(errorSpy.callCount, 1, 'precondition: log.error was called exactly once');
      assert.strictEqual(
        errorSpy.firstCall.args.length,
        1,
        '@stonyx/logs reads argument 2 as `logToFile` — log.error must be called with a single interpolated string',
      );
      assert.true(
        String(errorSpy.firstCall.args[0]).includes('async boom'),
        'the error text reaches the operator instead of being swallowed as a boolean',
      );
    });

    test('a rejecting logger cannot re-create the unhandled rejection this fix prevents', async function (assert) {
      sinon.stub(log, 'error').rejects(new Error('EISDIR: illegal operation on a directory'));

      cron.register('logfail', async () => { throw new Error('job boom'); }, '300', true);

      await clock.tickAsync(0);
      await realTick();
      await realTick();

      // Asserted here as well as in afterEach so the failure names this path.
      assert.strictEqual(rejections.length, 0, 'a failure inside the error handler did not escape as an unhandled rejection');
    });

    // The other failure mode of the same call, and the reachable one:
    // `@stonyx/logs`' `logAction` is NOT async — it dereferences
    // `this.typeOptions[type]` and `this.color.getLogColor(type)` before it
    // returns a promise — so a misconfigured log type throws *synchronously*
    // rather than rejecting. The same shape occurs on a `stonyx` build where
    // `log.warn` was never materialised.
    //
    // This is not a lost log line. `report` is called from the skip branch of
    // `safeInvoke`, which runs inside `runDueJobs`' drain loop with nothing
    // above it to catch: a synchronous throw escapes the loop, `scheduleNextRun`
    // never runs, and every other job stops — D1 reintroduced through the
    // reporting path added to fix D2.
    test('a logger that throws synchronously does not stop the scheduler', async function (assert) {
      sinon.stub(log, 'warn').throws(new TypeError('log.warn is not a function'));
      const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));
      const probe = sinon.spy();

      cron.register('hang', hang, '1');
      cron.register('probe', probe, '2');

      await clock.tickAsync(6000);

      // Precondition: the hung job is what drives `report` — it is skipped on
      // the tick after it hangs, and that skip is the throwing call.
      assert.strictEqual(hang.callCount, 1, 'precondition: the hung job was invoked once and then skipped');
      assert.ok(probe.callCount >= 2, `the unrelated job kept firing (fired ${probe.callCount}x, expected >= 2)`);
    });
  });

  module('SME WARNING 6 — the skip warning is bounded', function () {
    test('a permanently stuck job warns once per stuck run, not once per tick', async function (assert) {
      const warnSpy = sinon.stub(log, 'warn');
      const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));

      cron.register('stuck', hang, '1');

      await clock.tickAsync(6000);

      assert.strictEqual(hang.callCount, 1, 'precondition: the job is stuck after a single invocation');

      const skips = warnSpy.getCalls().filter(call => /still running/.test(String(call.args[0])));
      assert.strictEqual(skips.length, 1, 'exactly one skip warning across the five skipped ticks');
    });
  });
  module('SME WARNING — a long interval must not overflow setTimeout', function () {
    // `delay` is milliseconds. Above `TIMEOUT_MAX` (2,147,483,647 ms, ~24.9
    // days) Node truncates the timer to 1 ms, so `scheduleNextRun` re-arms
    // every millisecond forever while the job never fires. Measured
    // out-of-suite at `'86400000'` — a day expressed in *milliseconds* —
    // 3,163 wakeups and ~389 KB of `TimeoutOverflowWarning` stderr per 4 s,
    // roughly 8 GB/day, from one job that then never runs.
    //
    // Pre-existing: `scheduleNextRun` is byte-identical at `dev`, which
    // measures the same. It is taken here because it is the same
    // unit-confusion class the `'1h'` rejection exists to catch, arriving
    // through a value that parses cleanly as a number — shipping a validator
    // that rejects `'1h'` while accepting `'86400000'` invites the wrong
    // conclusion about what has been made safe.
    //
    // `@sinonjs/fake-timers` reproduces the truncation faithfully
    // (`fake-timers-src.js`: `timer.delay = timer.delay > maxTimeout ? 1 :
    // timer.delay`), so both assertions below discriminate in-suite.
    test('an interval beyond setTimeout\'s range does not spin the drain loop', async function (assert) {
      const drain = sinon.spy(cron, 'runDueJobs');
      const callback = sinon.spy();

      cron.register('overflow', callback, '86400000');

      await clock.tickAsync(5000);

      assert.strictEqual(drain.callCount, 0, 'the drain loop did not wake once in 5s of fake time (untruncated: ~5,000 wakeups)');
      assert.strictEqual(callback.callCount, 0, 'and the job was not run early');
    });

    // The other half: clamping must re-arm, not drop the job. A ceiling that
    // ran the job at the clamp boundary would be a worse defect than the spin.
    test('a long interval still fires exactly once, when it is actually due', async function (assert) {
      const callback = sinon.spy();

      // 2,147,484,000 ms — 353 ms past the ceiling, so it takes exactly two
      // timer hops: one to the ceiling, one for the remainder.
      cron.register('long', callback, '2147484');

      await clock.nextAsync();
      assert.strictEqual(callback.callCount, 0, 'the clamp re-armed rather than running the job early');

      await clock.nextAsync();
      assert.strictEqual(callback.callCount, 1, 'the job fired once, on its second hop, when actually due');
    });
  });

  module('SME WARNING — the documented same-tick overlap is pinned', function () {
    // README: "Two *different* jobs that fall due on the same tick may therefore
    // overlap." That was only incidentally exercised inside AC1; a regression
    // that reintroduced sequential draining for two distinct keys — while
    // keeping the hang non-blocking — would leave the README lying and the suite
    // green. Fails against `dev`, and against Mutation H (restore the drain
    // loop's `await`).
    test('two different jobs due on the same tick both fire', async function (assert) {
      sinon.stub(log, 'warn');
      const first = sinon.stub().callsFake(() => new Promise<void>(() => {}));
      const second = sinon.spy();

      cron.register('first', first, '2');
      cron.register('second', second, '2');

      await clock.tickAsync(2100);

      assert.strictEqual(first.callCount, 1, 'precondition: the first job fired and is still running');
      assert.strictEqual(second.callCount, 1, 'the second job fired on the same tick, while the first was still in flight');
    });
  });
});
