/**
 * Integration test — legacy Cron API (register/unregister).
 *
 * Demonstrates the simple interval-based scheduling that existed prior to
 * the advanced scheduling system. Consumers that only need "run this callback
 * every N seconds" use this API directly.
 */
import QUnit from 'qunit';
import sinon from 'sinon';
import Cron from '../../src/main.js';
import { definitions } from '../sample/payload.js';

const { module, test } = QUnit;

module('[Integration] Legacy Cron', function (hooks) {
  let cron;
  let clock;

  hooks.beforeEach(function () {
    Cron.instance = null;
    cron = new Cron();
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false, now: new Date('2026-06-15T12:00:00Z') });
  });

  hooks.afterEach(function () {
    Object.keys(cron.jobs).forEach(key => cron.unregister(key));
    clearTimeout(cron.timer);
    clock.restore();
    Cron.instance = null;
  });

  module('register and unregister', function () {
    test('registers a job and schedules it', function (assert) {
      const { key, interval } = definitions.legacyBackup;
      const callback = sinon.stub();

      cron.register(key, callback, interval);

      assert.ok(cron.jobs[key], 'job registered');
      assert.strictEqual(cron.jobs[key].interval, interval);
      assert.ok(cron.timer, 'timer armed');
    });

    test('runOnInit executes callback immediately', function (assert) {
      const { key, interval } = definitions.legacyHealthCheck;
      const callback = sinon.stub();

      cron.register(key, callback, interval, true);

      assert.ok(callback.calledOnce, 'callback invoked on init');
    });

    test('unregister removes job and reschedules', function (assert) {
      const callback = sinon.stub();
      cron.register('temp', callback, 600);

      assert.ok(cron.jobs['temp']);
      cron.unregister('temp');
      assert.notOk(cron.jobs['temp'], 'job removed');
    });

    test('unregister is safe on nonexistent key', function (assert) {
      cron.unregister('ghost');
      assert.ok(true, 'no error thrown');
    });
  });

  module('execution', function () {
    test('callback fires when due', async function (assert) {
      const callback = sinon.stub();
      cron.register('tick', callback, 10);

      await clock.tickAsync(11_000);

      assert.ok(callback.calledOnce, 'callback fired after interval elapsed');
    });

    test('callback reschedules after firing', async function (assert) {
      const callback = sinon.stub();
      cron.register('repeat', callback, 5);

      await clock.tickAsync(6_000);
      assert.ok(callback.calledOnce);

      await clock.tickAsync(5_000);
      assert.strictEqual(callback.callCount, 2, 'fired again on next interval');
    });

    test('error in callback is caught', async function (assert) {
      const callback = sinon.stub().throws(new Error('boom'));
      cron.register('bad', callback, 5);

      await clock.tickAsync(6_000);
      assert.ok(callback.calledOnce, 'callback attempted');
      assert.ok(true, 'no unhandled error');
    });
  });
});
