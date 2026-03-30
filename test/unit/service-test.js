import QUnit from 'qunit';
import sinon from 'sinon';
import { setupIntegrationTests } from 'stonyx/test-helpers';
import CronService from '../../src/service.js';
import { resetLock } from '../../src/locked.js';

const { module, test } = QUnit;

module('CronService', function (hooks) {
  setupIntegrationTests(hooks);
  let service;
  let clock;

  hooks.beforeEach(function () {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false, now: new Date('2026-06-15T12:00:00Z') });
    service = new CronService();
  });

  hooks.afterEach(function () {
    service.stop();
    clock.restore();
    resetLock();
  });

  module('lifecycle', function () {
    test('starts and stops', async function (assert) {
      await service.start();
      assert.ok(service.started);
      service.stop();
      assert.notOk(service.started);
    });

    test('start is idempotent', async function (assert) {
      await service.start();
      await service.start();
      assert.ok(service.started);
    });
  });

  module('CRUD', function () {
    test('add creates a job', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'Test Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'hello' },
      });

      assert.ok(job.id);
      assert.strictEqual(job.name, 'Test Job');
      assert.strictEqual(service.status().jobCount, 1);
    });

    test('get retrieves a job', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'Test',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'hi' },
      });

      assert.deepEqual(service.get(job.id), job);
      assert.strictEqual(service.get('nonexistent'), null);
    });

    test('list returns enabled jobs sorted by nextRunAtMs', async function (assert) {
      await service.start();
      await service.add({
        name: 'Later',
        schedule: { kind: 'every', everyMs: 120_000 },
        payload: { kind: 'agentTurn', message: 'hi' },
      });
      await service.add({
        name: 'Sooner',
        schedule: { kind: 'every', everyMs: 30_000 },
        payload: { kind: 'agentTurn', message: 'hi' },
      });

      const jobs = service.list();
      assert.strictEqual(jobs.length, 2);
      assert.strictEqual(jobs[0].name, 'Sooner');
      assert.strictEqual(jobs[1].name, 'Later');
    });

    test('list with includeDisabled', async function (assert) {
      await service.start();
      await service.add({
        name: 'Active',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'hi' },
      });
      await service.add({
        name: 'Disabled',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'hi' },
        enabled: false,
      });

      assert.strictEqual(service.list().length, 1);
      assert.strictEqual(service.list({ includeDisabled: true }).length, 2);
    });

    test('update modifies a job', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'Old Name',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'hi' },
      });

      const updated = await service.update(job.id, { name: 'New Name' });
      assert.strictEqual(updated.name, 'New Name');
    });

    test('update throws on missing job', async function (assert) {
      await service.start();
      try {
        await service.update('fake-id', { name: 'nope' });
        assert.ok(false, 'should throw');
      } catch (err) {
        assert.ok(err.message.includes('not found'));
      }
    });

    test('remove deletes a job', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'Doomed',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'hi' },
      });

      await service.remove(job.id);
      assert.strictEqual(service.status().jobCount, 0);
      assert.strictEqual(service.get(job.id), null);
    });

    test('remove throws on missing job', async function (assert) {
      await service.start();
      try {
        await service.remove('fake-id');
        assert.ok(false, 'should throw');
      } catch (err) {
        assert.ok(err.message.includes('not found'));
      }
    });
  });

  module('execution', function () {
    test('timer fires and executes due job', async function (assert) {
      const executed = [];
      service.onJobDue = (job) => {
        executed.push(job.name);
        return { status: 'ok', summary: 'done' };
      };

      await service.start();
      await service.add({
        name: 'Timer Test',
        schedule: { kind: 'every', everyMs: 30_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      // Advance past the job's next run time (tickAsync flushes microtasks)
      await clock.tickAsync(31_000);

      assert.deepEqual(executed, ['Timer Test']);
    });

    test('manual run with force', async function (assert) {
      let executed = false;
      service.onJobDue = () => {
        executed = true;
        return { status: 'ok' };
      };

      await service.start();
      const job = await service.add({
        name: 'Manual',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      await service.run(job.id, 'force');
      assert.ok(executed);
    });

    test('manual run with due mode skips if not due', async function (assert) {
      service.onJobDue = () => ({ status: 'ok' });

      await service.start();
      const job = await service.add({
        name: 'Not Due',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      const result = await service.run(job.id, 'due');
      assert.strictEqual(result.status, 'skipped');
    });

    test('run throws on missing job', async function (assert) {
      await service.start();
      try {
        await service.run('fake');
        assert.ok(false, 'should throw');
      } catch (err) {
        assert.ok(err.message.includes('not found'));
      }
    });

    test('error in onJobDue is caught and logged', async function (assert) {
      service.onJobDue = () => { throw new Error('kaboom'); };

      await service.start();
      const job = await service.add({
        name: 'Failing',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      const result = await service.run(job.id);
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('kaboom'));
    });

    test('one-shot job is deleted after successful run with deleteAfterRun', async function (assert) {
      service.onJobDue = () => ({ status: 'ok' });

      await service.start();
      const future = new Date(Date.now() + 60_000).toISOString();
      const job = await service.add({
        name: 'Once',
        schedule: { kind: 'at', at: future },
        payload: { kind: 'agentTurn', message: 'go' },
        deleteAfterRun: true,
      });

      const result = await service.run(job.id);
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.deleted, true);
      assert.strictEqual(service.get(job.id), null);
    });
  });

  module('run history', function () {
    test('runs returns execution history', async function (assert) {
      service.onJobDue = () => ({ status: 'ok', summary: 'done' });

      await service.start();
      const job = await service.add({
        name: 'Logged',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      await service.run(job.id);
      await service.run(job.id);

      const history = service.runs(job.id);
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].status, 'ok');
    });
  });

  module('status', function () {
    test('reports correct state', async function (assert) {
      await service.start();
      const s1 = service.status();
      assert.strictEqual(s1.started, true);
      assert.strictEqual(s1.jobCount, 0);
      assert.strictEqual(s1.nextWakeAtMs, undefined);

      await service.add({
        name: 'Test',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      const s2 = service.status();
      assert.strictEqual(s2.jobCount, 1);
      assert.ok(s2.nextWakeAtMs);
    });
  });

  module('normalization integration', function () {
    test('handles flat params from AI', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'AI Created',
        schedule: { everyMs: 60000 },
        message: 'check the weather',
      });

      assert.strictEqual(job.schedule.kind, 'every');
      assert.strictEqual(job.payload.kind, 'agentTurn');
      assert.strictEqual(job.payload.message, 'check the weather');
    });
  });
});
