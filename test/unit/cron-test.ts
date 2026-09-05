import { readFile } from 'node:fs/promises';
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import Cron from '@stonyx/cron';
import config from 'stonyx/config';
import log from 'stonyx/log';
import { setupIntegrationTests } from "stonyx/test-helpers";

const { module, test } = QUnit;

module('[Unit] Cron', function (hooks) {
  setupIntegrationTests(hooks);

  let cron: Cron;
  let clock: SinonFakeTimers;

  hooks.beforeEach(function () {
    // Use fake timers
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
    cron = new Cron();
  });

  hooks.afterEach(function () {
    sinon.restore();
  });

  test('register schedules job and runs it when due', async function (assert) {
    const cb = sinon.spy();
    cron.register('job1', cb, '5'); // interval 5s

    // Advance just before due
    clock.tick(4900);
    assert.ok(cb.notCalled, 'Job not yet triggered');

    // Advance to due
    clock.tick(200);
    await clock.tickAsync(0);

    assert.ok(cb.calledOnce, 'Job callback executed when due');
  });

  test('register with runOnInit runs immediately', function (assert) {
    const cb = sinon.spy();
    cron.register('job2', cb, '5', true);
    assert.ok(cb.calledOnce, 'Callback ran immediately when runOnInit is true');
  });

  test('unregister stops job from running', function (assert) {
    const cb = sinon.spy();
    cron.register('job3', cb, '5');
    cron.unregister('job3');

    // Advance beyond interval
    clock.tick(6000);
    assert.ok(cb.notCalled, 'Unregistered job did not run');
  });

  test('job reschedules after running', async function (assert) {
    const cb = sinon.spy();
    cron.register('job4', cb, '5');

    // Trigger first run
    clock.tick(5000);
    await clock.tickAsync(0);
    assert.ok(cb.calledOnce, 'First run executed');

    // Trigger second run
    clock.tick(5000);
    await clock.tickAsync(0);
    assert.ok(cb.calledTwice, 'Second run executed after rescheduling');
  });

  test('log method respects config.cron.log', function (assert) {
    const stub = sinon.spy(log, 'cron');

    config.cron.log = true;
    cron.log('test log on');
    assert.ok(stub.calledOnce, 'Log function called when logging is enabled');

    config.cron.log = false;
    cron.log('test log off');
    assert.ok(stub.calledOnce, 'Log function not called when logging is disabled');
  });

  test('errors in job callback are caught and logged', async function (assert) {
    const error = new Error('boom');
    const cb = sinon.stub().rejects(error);
    const stub = sinon.spy(log, 'error');

    cron.register('jobErr', cb, '1');

    // Advance 1s
    clock.tick(1000);
    await clock.tickAsync(0);

    assert.ok(stub.calledWithMatch(sinon.match(/Cron job "jobErr" failed:/)), 'Error logged');
  });

  module('self-registers log type in init() (#32)', function (innerHooks) {
    innerHooks.afterEach(function () {
      sinon.restore();
    });

    test('registers cron log type on init', async function (assert) {
      assert.strictEqual(typeof log.defineType, 'function', 'log.defineType is available');

      const c = new Cron();
      await c.init();

      assert.strictEqual(typeof log.cron, 'function', 'log.cron is callable after init');
    });

    test('idempotent: calling init twice does not throw', async function (assert) {
      const c1 = new Cron();
      await c1.init();

      const c2 = new Cron();
      await c2.init();

      assert.strictEqual(typeof log.cron, 'function', 'log.cron still callable after second init');
    });
  });
});

/**
 * #36 — legacy `Cron` invokes consumer callbacks unsafely.
 *
 * D1: `runDueJobs` awaits `job.callback()` with no bound and no lock, so a
 *     callback that never settles prevents `scheduleNextRun()` from ever being
 *     reached and the legacy scheduler dies silently.
 * D2: `register(..., runOnInit = true)` invokes `callback()` inside a
 *     *synchronous* try/catch without awaiting, so an async callback's
 *     rejection escapes the catch entirely.
 *
 * House pattern: sinon fake timers with `shouldAdvanceTime: false`. Hang probes
 * never await the hung promise — they advance the clock and assert on an
 * observable counter, so a regressed path fails cleanly instead of timing out.
 */
module('[Unit] Cron — safe callback invocation (#36)', function (hooks) {
  setupIntegrationTests(hooks);

  let cron: Cron;
  let clock: SinonFakeTimers;
  let unhandled: unknown[];
  let captureRejection: (reason: unknown) => void;
  let previousCronLog: boolean | undefined;

  hooks.beforeEach(async function () {
    Cron.instance = null;
    cron = new Cron();
    await cron.init();

    // Captured, not assumed. Restoring to a hardcoded literal in `afterEach`
    // silently corrupts the shared config singleton for every later module the
    // day `test/config/environment.ts` changes its pin.
    previousCronLog = config.cron.log;

    unhandled = [];
    captureRejection = reason => unhandled.push(reason);
    process.on('unhandledRejection', captureRejection);

    clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
  });

  hooks.afterEach(function () {
    process.off('unhandledRejection', captureRejection);
    Object.keys(cron.jobs).forEach(key => cron.unregister(key));
    if (cron.timer) clearTimeout(cron.timer);
    sinon.restore();
    config.cron.log = previousCronLog;
    Cron.instance = null;
  });

  // Re-land guard (issue reopen, requirement 2): the 2026-09-01 revert wave was
  // invisible because nothing asserted on `dist/`. This module's `Cron` is the
  // self-referenced package entry, so every assertion below executes the built
  // artifact rather than `src/`. Pin that, otherwise the coverage silently
  // degrades to source-only the moment resolution changes.
  test('the acceptance coverage below runs against the built artifact', function (assert) {
    const resolved = import.meta.resolve('@stonyx/cron');

    assert.ok(
      resolved.endsWith('/dist/main.js'),
      `Cron under test is the built entry point (resolved to ${resolved})`,
    );
  });

  // Requirement 1 of the reopen: "no public API change" has to be checked in the
  // EMITTED declarations, not in source. `CronJob` is not exported by name but is
  // structurally reachable through `jobs`, `heap` and `setNextTrigger`, so a new
  // REQUIRED member breaks any consumer TS that builds a job object. Optional
  // members are additive and safe.
  test('the emitted CronJob type gains no required member', async function (assert) {
    const dts = await readFile(new URL('../../dist/main.d.ts', import.meta.url), 'utf8');
    const block = /interface CronJob extends HeapItem \{([\s\S]*?)\n\}/.exec(dts);

    assert.ok(block, 'precondition: CronJob is present in the emitted declarations');

    const required = [...(block?.[1] ?? '').matchAll(/^ {4}(\w+)(\??):/gm)]
      .filter(m => m[2] !== '?')
      .map(m => m[1]);

    assert.deepEqual(
      required.sort(),
      ['callback', 'interval', 'key'],
      `only the pre-existing members are required (got ${JSON.stringify(required)})`,
    );
  });

  test('AC1 — a job whose callback never settles does not stop other jobs from firing', async function (assert) {
    // The hung promise is never awaited by the test — the clock is advanced and
    // the co-registered probe's counter is asserted, so a regression fails the
    // assertion instead of hanging the runner.
    const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));
    const probe = sinon.spy();

    cron.register('hang', hang, '1');
    cron.register('probe', probe, '2');

    await clock.tickAsync(6000);

    assert.strictEqual(hang.callCount, 1, 'precondition: the hung job was actually driven once');
    // Strict, not `>= 2`. Under fake timers a '2's interval over 6000ms is
    // deterministically 3, so an exact count also catches OVER-firing — a
    // stacking regression that a `>=` bound would wave through.
    assert.strictEqual(probe.callCount, 3, `co-registered job fired on every due tick while "hang" was stuck (fired ${probe.callCount}x)`);
  });

  test('AC1 — the hung job stays in the heap and the timer stays armed', async function (assert) {
    const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));

    cron.register('hang', hang, '1');

    await clock.tickAsync(6000);

    assert.strictEqual(hang.callCount, 1, 'precondition: the hung job was actually driven once');
    assert.ok(cron.heap.items.some(item => item.key === 'hang'), 'hung job is still present in the heap');

    // NOT `notStrictEqual(cron.timer, null)`. On `dev` the scheduler is dead and
    // `timer` still holds the *already-fired* handle from the last tick, so that
    // assertion is true in exactly the state its message claims to exclude — a
    // check that cannot fail. A live scheduler re-arms, which replaces the
    // handle; a dead one keeps the same object forever.
    const handleAfterHang = cron.timer;
    assert.notStrictEqual(handleAfterHang, null, 'precondition: a timer handle exists');

    await clock.tickAsync(2000);

    assert.notStrictEqual(
      cron.timer,
      handleAfterHang,
      'scheduler re-armed with a NEW timer handle while the job stayed hung',
    );
  });

  test('AC2 — an async runOnInit rejection is logged, not left unhandled', async function (assert) {
    const errorSpy = sinon.stub(log, 'error');

    cron.register('asyncInit', async () => {
      throw new Error('SENTINEL_ASYNC_BOOM');
    }, '300', true);

    await clock.tickAsync(0);

    assert.strictEqual(unhandled.length, 0, 'no unhandled rejection escaped register()');

    const call = errorSpy.getCalls().find(c => /Cron job "asyncInit" failed on init/.test(String(c.args[0])));
    assert.ok(call, 'async init failure was logged');

    // The prefix alone is a vacuous assertion: `log.error(msg, err)` renders the
    // prefix and drops the error entirely, because `@stonyx/logs` reads argument
    // 2 as `logToFile`, not as a format argument. Assert the error TEXT, and
    // assert nothing is passed in the `logToFile` slot.
    assert.ok(
      String(call?.args[0]).includes('SENTINEL_ASYNC_BOOM'),
      `the rejected error itself appears in the report (got: ${String(call?.args[0])})`,
    );
    assert.strictEqual(call?.args.length, 1, 'log.error is called with exactly one argument (arg 2 is logToFile)');
  });

  test('AC2 — a synchronous runOnInit throw is still logged and still scheduled', function (assert) {
    const errorSpy = sinon.stub(log, 'error');

    cron.register('syncInit', () => {
      throw new Error('SENTINEL_SYNC_BOOM');
    }, '300', true);

    const call = errorSpy.getCalls().find(c => /Cron job "syncInit" failed on init/.test(String(c.args[0])));
    assert.ok(call, 'sync init failure is still logged');
    assert.ok(
      String(call?.args[0]).includes('SENTINEL_SYNC_BOOM'),
      `the thrown error itself appears in the report (got: ${String(call?.args[0])})`,
    );
    assert.strictEqual(call?.args.length, 1, 'log.error is called with exactly one argument (arg 2 is logToFile)');
    assert.ok(cron.heap.items.some(item => item.key === 'syncInit'), 'job is still scheduled after a sync init throw');
  });

  test('AC3 — a job still running when next due is skipped, then resumes once it settles', async function (assert) {
    // Deliberately NOT enabling `config.cron.log`. A dropped execution reported
    // through a channel a config flag can silence is indistinguishable from a
    // healthy scheduler, so the skip signal is ungated — matching the sibling
    // `CronService` handler in the same release.
    assert.notOk(config.cron.log, 'precondition: cron logging is OFF for this test');
    const warnSpy = sinon.stub(log, 'warn');

    let release: () => void = () => {};
    const slow = sinon.stub().callsFake(() => new Promise<void>(resolve => { release = resolve; }));

    cron.register('slow', slow, '1');

    await clock.tickAsync(3000);

    assert.strictEqual(slow.callCount, 1, 'in-flight job was invoked exactly once across three due ticks');
    assert.ok(
      warnSpy.calledWithMatch(sinon.match(/is still running after/)),
      'skipped run was reported on the ungated channel with config.cron.log off',
    );

    release();
    await clock.tickAsync(1000);

    assert.strictEqual(slow.callCount, 2, 'job is invoked again on the next due tick once it settles');
  });

  test('the stuck-job warning is emitted once per stuck run, not once per tick', async function (assert) {
    const warnSpy = sinon.stub(log, 'warn');

    let release: () => void = () => {};
    const slow = sinon.stub().callsFake(() => new Promise<void>(resolve => { release = resolve; }));

    cron.register('slow', slow, '1');

    await clock.tickAsync(10_000);

    const skips = () => warnSpy.getCalls().filter(c => /is still running after/.test(String(c.args[0]))).length;

    // Ten due ticks, nine of them skipped. One line per tick is ~43,200/day for
    // a single hung job at this interval, which pushes an operator to disable
    // the only signal they have.
    assert.strictEqual(slow.callCount, 1, 'precondition: the job really was stuck across ten ticks');
    assert.strictEqual(skips(), 1, `stuck-job warning emitted once, not once per tick (got ${skips()})`);

    // A later stuck run reports again — the flag bounds one run, not the job.
    release();
    await clock.tickAsync(2000);
    assert.strictEqual(slow.callCount, 2, 'precondition: a second invocation started and is stuck too');

    await clock.tickAsync(3000);
    assert.strictEqual(skips(), 2, `the NEXT stuck run reports again (got ${skips()})`);
  });

  test('a job that rejects keeps running on later ticks', async function (assert) {
    sinon.stub(log, 'error');
    const cb = sinon.stub().callsFake(async () => { throw new Error('boom'); });

    cron.register('rejecter', cb, '1');

    await clock.tickAsync(3000);

    // The in-flight guard must be released on the rejection path. If it is not,
    // one rejection marks the job permanently in-flight and it never runs again
    // — silent per-job scheduler death, re-entering through this fix's own
    // mechanism.
    assert.strictEqual(cb.callCount, 3, `rejecting job still fires on every later tick (fired ${cb.callCount}x)`);
  });

  test('a job that throws synchronously keeps running on later ticks', async function (assert) {
    sinon.stub(log, 'error');
    const cb = sinon.stub().callsFake(() => { throw new Error('boom'); });

    cron.register('thrower', cb, '1');

    await clock.tickAsync(3000);

    assert.strictEqual(cb.callCount, 3, `throwing job still fires on every later tick (fired ${cb.callCount}x)`);
  });

  // The guard is `if (result && typeof result.then === 'function')`. Every other
  // test drives only the `!result` clause (sinon spies return `undefined`), so
  // the second clause — a truthy, non-thenable return — was the one uncovered
  // sub-branch of the helper. Asserted SYNCHRONOUSLY and deliberately: the
  // documented reason for duck-checking rather than wrapping in
  // `Promise.resolve(result)` is that the synchronous path must clear the guard
  // in the same tick, not a microtask later. Awaiting first would flush the
  // microtask and make the assertion true either way.
  test('a callback returning a truthy non-thenable releases its guard in the same tick', function (assert) {
    const cb = sinon.stub().returns(42 as unknown as void);

    cron.register('truthy', cb, '1', true);

    assert.strictEqual(cb.callCount, 1, 'precondition: the callback ran on init and returned a non-thenable');
    assert.strictEqual(
      cron.jobs['truthy']?.runningAtMs,
      undefined,
      'in-flight guard released synchronously, before any microtask could run',
    );
    assert.strictEqual(cron.jobs['truthy']?.skipReported, false, 'skip-report flag reset with the guard');
  });

  test('a callback returning a truthy non-thenable keeps firing on later ticks', async function (assert) {
    const cb = sinon.stub().returns(42 as unknown as void);

    cron.register('truthy', cb, '1');

    await clock.tickAsync(3000);

    assert.strictEqual(cb.callCount, 3, `non-thenable-returning job fired on every due tick (fired ${cb.callCount}x)`);
  });

  test('unregister of a still-running job actually stops it', async function (assert) {
    let release: () => void = () => {};
    const slow = sinon.stub().callsFake(() => new Promise<void>(r => { release = r; }));

    cron.register('slow', slow, '1');
    await clock.tickAsync(1500);
    assert.strictEqual(slow.callCount, 1, 'precondition: job is in flight');

    cron.unregister('slow');
    release();
    await clock.tickAsync(5000);

    // On `dev` the hung job is absent from the heap when `unregister` runs, so
    // `heap.remove` is a no-op and the settling callback re-pushes the
    // *unregistered* job — it keeps firing forever. `unregister()` reported
    // success and did nothing.
    assert.strictEqual(slow.callCount, 1, 'unregistered job never fires again');
  });

  test('a callback returning a thenable whose `then` throws cannot stop the scheduler', async function (assert) {
    // Not exotic: query builders and lazily-constructed deferreds expose `then`
    // through a getter. Probing it outside the guard aborts the drain loop
    // before `scheduleNextRun()` — defect #36's terminal state, with `timer`
    // still non-null so the scheduler reads healthy.
    const errorSpy = sinon.stub(log, 'error');
    const evil = (() => ({ get then(): never { throw new Error('evil then'); } })) as unknown as () => void;
    const probe = sinon.spy();

    cron.register('evil', evil, '1');
    cron.register('probe', probe, '1');

    const handleBefore = cron.timer;
    await clock.tickAsync(5000);

    // Pins `invokeJob`'s guard specifically: if the thenable probe sits outside
    // the `try`, the throw escapes before either of these can happen — nothing
    // is reported, and the job's in-flight guard is never released, so `evil` is
    // permanently wedged even though the scheduler survives.
    assert.ok(
      errorSpy.calledWithMatch(sinon.match(/Cron job "evil" failed/)),
      'the throwing thenable was reported as a job failure',
    );
    assert.strictEqual(
      cron.jobs['evil']?.runningAtMs,
      undefined,
      'the evil job released its in-flight guard rather than wedging permanently',
    );

    // Pins the outer guards: the drain loop must still re-arm, and nothing may
    // reach the process as an unhandled rejection.
    assert.strictEqual(probe.callCount, 5, `co-registered job kept firing (fired ${probe.callCount}x)`);
    assert.notStrictEqual(cron.timer, handleBefore, 'scheduler re-armed rather than dying with a fired handle');
    assert.strictEqual(unhandled.length, 0, 'no unhandled rejection escaped the scheduler tick');
  });

  test('the drain loop re-arms the scheduler even if invokeJob itself throws', async function (assert) {
    const probe = sinon.spy();
    cron.register('probe', probe, '1');

    // Direct coverage for the two outer guards, which `invokeJob` being total
    // otherwise makes unreachable: the `finally` in `runDueJobs` and the
    // terminal `.catch` on the timer callback in `scheduleNextRun`.
    const stub = sinon.stub(cron, 'invokeJob').throws(new Error('invokeJob exploded'));
    const handleBefore = cron.timer;

    await clock.tickAsync(1200);

    assert.ok(stub.called, 'precondition: the throwing invokeJob was actually reached');
    assert.notStrictEqual(cron.timer, handleBefore, 'scheduleNextRun() still ran despite the throw');
    assert.strictEqual(unhandled.length, 0, 'the escaping throw did not become an unhandled rejection');
  });

  /*
   * Phase 3 HIGH-1 residue. Items 1-3 of that finding (thenable probe inside the
   * `try`, `finally` in the drain loop, terminal `.catch` on the timer callback)
   * landed in `be52ad6`. Its fourth measured symptom — "`register` breaks too:
   * `register()` threw to the consumer, `timer armed: false`" — did not: the
   * drain loop's `finally` has no counterpart at the `register` call site, and
   * `invokeJob` is not actually total, because the reporting path itself reads
   * consumer-controlled values (`err.stack`, `String(err)`) that can throw. The
   * drain loop survives such a throw but does not finish draining, so the cost
   * lands on whichever jobs were due behind the throwing one.
   */

  test('an error whose `stack` getter throws is reported without wedging register', function (assert) {
    const errorSpy = sinon.stub(log, 'error');
    const err = new Error('boom');

    // Not a proxy and not contrived: any code that redefines `stack` (error
    // serializers, some instrumentation shims) can produce this. `describeError`
    // reads `err.stack` first, so the throw happens inside the reporting path
    // that exists to keep a callback failure from reaching the scheduler.
    Object.defineProperty(err, 'stack', { get(): never { throw new Error('stack getter exploded'); } });

    cron.register('poisoned', () => { throw err; }, '1', true);

    assert.ok(
      errorSpy.calledWithMatch(sinon.match(/Cron job "poisoned" failed on init/)),
      'the callback failure was still reported',
    );
    assert.notStrictEqual(cron.timer, null, 'register() reached scheduleNextRun() — the job is actually scheduled');
    assert.strictEqual(cron.jobs['poisoned']?.runningAtMs, undefined, 'the in-flight guard was released');
  });

  test('a thrown value with no string conversion does not abort the drain loop', async function (assert) {
    const errorSpy = sinon.stub(log, 'error');
    const probe = sinon.spy();

    // `String(Object.create(null))` throws `TypeError: Cannot convert object to
    // primitive value` — plain JS, no proxy. Escaping `invokeJob` aborts the
    // `while` loop, so a co-registered job due on the SAME tick is never
    // invoked: one callback's failure costs another job its execution, which is
    // the cross-job blast radius #36 exists to remove. `scheduleNextRun()` still
    // runs (the drain loop's `finally`), so the scheduler reads healthy while
    // the co-registered job silently loses runs.
    //
    // Registration order matters: `nostring` must be drained first, so it is
    // registered first and both share the same interval.
    cron.register('nostring', () => { throw Object.create(null) as never; }, '1');
    cron.register('probe', probe, '1');

    await clock.tickAsync(3000);

    assert.ok(
      errorSpy.calledWithMatch(sinon.match(/Cron job "nostring" failed/)),
      'the unconvertible thrown value was reported as a job failure, not as a scheduler failure',
    );
    assert.strictEqual(probe.callCount, 3, `co-registered job fired on every due tick (fired ${probe.callCount}x)`);
  });

  test('register re-arms the scheduler even if invokeJob itself throws', function (assert) {
    // Structural backstop, mirroring the drain-loop test above. `invokeJob` is
    // total once `describeError` is, so this guard is otherwise unreachable —
    // which is exactly why it needs direct coverage rather than trusting that
    // nothing inside `invokeJob` will ever throw again.
    const stub = sinon.stub(cron, 'invokeJob').throws(new Error('invokeJob exploded'));

    assert.throws(
      () => cron.register('probe', () => {}, '1', true),
      /invokeJob exploded/,
      'the escaping throw is surfaced to the caller rather than swallowed',
    );
    assert.ok(stub.called, 'precondition: the throwing invokeJob was actually reached');
    assert.notStrictEqual(cron.timer, null, 'scheduleNextRun() still ran despite the throw');
  });

  test('a newline in a job key cannot forge a log line', async function (assert) {
    const warnSpy = sinon.stub(log, 'warn');
    const key = 'a:\n[FORGED] Cron::admin - all jobs healthy';

    cron.register(key, () => new Promise<void>(() => {}), '1');

    await clock.tickAsync(3000);

    const call = warnSpy.getCalls().find(c => /is still running after/.test(String(c.args[0])));
    assert.ok(call, 'precondition: the stuck-job warning fired for the hostile key');
    assert.notOk(
      /[\r\n]/.test(String(call?.args[0])),
      `the reported line carries no raw line terminator (got: ${JSON.stringify(String(call?.args[0]))})`,
    );
    assert.ok(String(call?.args[0]).includes('[FORGED]'), 'the key is still reported, escaped rather than dropped');
  });
});
