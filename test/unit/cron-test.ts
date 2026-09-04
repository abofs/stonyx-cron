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

  hooks.beforeEach(async function () {
    Cron.instance = null;
    cron = new Cron();
    await cron.init();

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
    config.cron.log = false;
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
    assert.ok(probe.callCount >= 2, `co-registered job kept firing while "hang" was stuck (fired ${probe.callCount}x)`);
  });

  test('AC1 — the hung job stays in the heap and the timer stays armed', async function (assert) {
    const hang = sinon.stub().callsFake(() => new Promise<void>(() => {}));

    cron.register('hang', hang, '1');

    await clock.tickAsync(6000);

    assert.strictEqual(hang.callCount, 1, 'precondition: the hung job was actually driven once');
    assert.ok(cron.heap.items.some(item => item.key === 'hang'), 'hung job is still present in the heap');
    assert.notStrictEqual(cron.timer, null, 'scheduler timer is still armed');
  });

  test('AC2 — an async runOnInit rejection is logged, not left unhandled', async function (assert) {
    const errorSpy = sinon.spy(log, 'error');

    cron.register('asyncInit', async () => {
      throw new Error('async boom');
    }, '300', true);

    await clock.tickAsync(0);

    assert.strictEqual(unhandled.length, 0, 'no unhandled rejection escaped register()');
    assert.ok(
      errorSpy.calledWithMatch(sinon.match(/Cron job "asyncInit" failed on init/)),
      'async init failure was logged',
    );
  });

  test('AC2 — a synchronous runOnInit throw is still logged and still scheduled', function (assert) {
    const errorSpy = sinon.spy(log, 'error');

    cron.register('syncInit', () => {
      throw new Error('sync boom');
    }, '300', true);

    assert.ok(
      errorSpy.calledWithMatch(sinon.match(/Cron job "syncInit" failed on init/)),
      'sync init failure is still logged',
    );
    assert.ok(cron.heap.items.some(item => item.key === 'syncInit'), 'job is still scheduled after a sync init throw');
  });

  test('AC3 — a job still running when next due is skipped, then resumes once it settles', async function (assert) {
    config.cron.log = true;
    const cronLog = sinon.spy(log, 'cron');

    let release: () => void = () => {};
    const slow = sinon.stub().callsFake(() => new Promise<void>(resolve => { release = resolve; }));

    cron.register('slow', slow, '1');

    await clock.tickAsync(3000);

    assert.strictEqual(slow.callCount, 1, 'in-flight job was invoked exactly once across three due ticks');
    assert.ok(cronLog.calledWithMatch(sinon.match(/still running/)), 'skipped run was logged');

    release();
    await clock.tickAsync(1000);

    assert.strictEqual(slow.callCount, 2, 'job is invoked again on the next due tick once it settles');
  });
});
