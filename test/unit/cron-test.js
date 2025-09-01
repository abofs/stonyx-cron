import QUnit from 'qunit';
import sinon from 'sinon';
import Cron from '@stonyx/cron';
import config from 'stonyx/config';
import log from 'stonyx/log';
import { setupIntegrationTests } from "stonyx/test-helpers";

const { module, test } = QUnit;

module('[Unit] Cron', function (hooks) {
  setupIntegrationTests(hooks);

  let cron, clock;

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
    cron.register('job1', cb, 5); // interval 5s

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
    cron.register('job2', cb, 5, true);
    assert.ok(cb.calledOnce, 'Callback ran immediately when runOnInit is true');
  });

  test('unregister stops job from running', function (assert) {
    const cb = sinon.spy();
    cron.register('job3', cb, 5);
    cron.unregister('job3');

    // Advance beyond interval
    clock.tick(6000);
    assert.ok(cb.notCalled, 'Unregistered job did not run');
  });

  test('job reschedules after running', async function (assert) {
    const cb = sinon.spy();
    cron.register('job4', cb, 5);

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

    cron.register('jobErr', cb, 1);

    // Advance 1s
    clock.tick(1000);
    await clock.tickAsync(0);

    assert.ok(stub.calledWithMatch(/Cron job "jobErr" failed:/), 'Error logged');
  });
});
