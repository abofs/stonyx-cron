import QUnit from 'qunit';
import sinon from 'sinon';
const { module, test } = QUnit;
import { setupIntegrationTests } from 'stonyx/test-helpers';
import CronService from '../../src/service.js';
import { resetLock } from '../../src/locked.js';

module('CronService persistence', function (hooks) {
  setupIntegrationTests(hooks);
  let service;
  let clock;
  let mockPersist;

  hooks.beforeEach(function () {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false, now: new Date('2026-06-15T12:00:00Z') });

    mockPersist = {
      loadJobs: sinon.stub().returns([]),
      saveJob: sinon.stub(),
      removeJob: sinon.stub(),
      saveRun: sinon.stub(),
      save: sinon.stub().resolves(),
    };

    service = new CronService();
    service.persist = mockPersist;
  });

  hooks.afterEach(function () {
    service.stop();
    clock.restore();
    resetLock();
  });

  module('start', function () {
    test('loads jobs from persistence on start', async function (assert) {
      mockPersist.loadJobs.returns([
        {
          id: 'persisted-1',
          name: 'Saved Job',
          enabled: true,
          schedule: { kind: 'every', everyMs: 60_000 },
          payload: { kind: 'agentTurn', message: 'hi' },
          state: { nextRunAtMs: Date.now() + 30_000, consecutiveErrors: 0 },
        },
      ]);

      await service.start();
      assert.strictEqual(service.status().jobCount, 1);
      assert.strictEqual(service.get('persisted-1').name, 'Saved Job');
    });

    test('prefers explicit initialJobs over persistence', async function (assert) {
      mockPersist.loadJobs.returns([
        { id: 'from-store', name: 'Store', enabled: true, schedule: { kind: 'every', everyMs: 60_000 }, payload: { kind: 'agentTurn', message: 'hi' }, state: { nextRunAtMs: Date.now() + 30_000, consecutiveErrors: 0 } },
      ]);

      await service.start([
        { id: 'explicit', name: 'Explicit', enabled: true, schedule: { kind: 'every', everyMs: 60_000 }, payload: { kind: 'agentTurn', message: 'hi' }, state: { nextRunAtMs: Date.now() + 30_000, consecutiveErrors: 0 } },
      ]);

      assert.strictEqual(service.status().jobCount, 1);
      assert.ok(service.get('explicit'));
      assert.strictEqual(service.get('from-store'), null);
    });
  });

  module('add', function () {
    test('persists new job', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'New Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      assert.ok(mockPersist.saveJob.calledOnce);
      assert.strictEqual(mockPersist.saveJob.firstCall.args[0].id, job.id);
      assert.ok(mockPersist.save.called);
    });
  });

  module('update', function () {
    test('persists updated job', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'Original',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      mockPersist.saveJob.resetHistory();
      mockPersist.save.resetHistory();

      await service.update(job.id, { name: 'Updated' });

      assert.ok(mockPersist.saveJob.calledOnce);
      assert.strictEqual(mockPersist.saveJob.firstCall.args[0].name, 'Updated');
      assert.ok(mockPersist.save.called);
    });
  });

  module('remove', function () {
    test('removes from persistence', async function (assert) {
      await service.start();
      const job = await service.add({
        name: 'Doomed',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      mockPersist.removeJob.resetHistory();
      mockPersist.save.resetHistory();

      await service.remove(job.id);

      assert.ok(mockPersist.removeJob.calledOnce);
      assert.strictEqual(mockPersist.removeJob.firstCall.args[0], job.id);
      assert.ok(mockPersist.save.called);
    });
  });

  module('execution', function () {
    test('persists run log entry after execution', async function (assert) {
      service.onJobDue = () => ({ status: 'ok', summary: 'done' });

      await service.start();
      const job = await service.add({
        name: 'Runner',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      mockPersist.saveRun.resetHistory();
      await service.run(job.id);

      assert.ok(mockPersist.saveRun.calledOnce);
      const entry = mockPersist.saveRun.firstCall.args[0];
      assert.strictEqual(entry.jobId, job.id);
      assert.strictEqual(entry.status, 'ok');
    });

    test('persists job state after execution', async function (assert) {
      service.onJobDue = () => ({ status: 'ok' });

      await service.start();
      const job = await service.add({
        name: 'Stateful',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      mockPersist.saveJob.resetHistory();
      await service.run(job.id);

      assert.ok(mockPersist.saveJob.called);
    });

    test('persists removal on one-shot deleteAfterRun', async function (assert) {
      service.onJobDue = () => ({ status: 'ok' });

      await service.start();
      const future = new Date(Date.now() + 60_000).toISOString();
      const job = await service.add({
        name: 'Once',
        schedule: { kind: 'at', at: future },
        payload: { kind: 'agentTurn', message: 'go' },
        deleteAfterRun: true,
      });

      mockPersist.removeJob.resetHistory();
      const result = await service.run(job.id);

      assert.strictEqual(result.deleted, true);
      assert.ok(mockPersist.removeJob.calledOnce);
    });
  });

  module('without persistence', function () {
    test('works normally when persist is null', async function (assert) {
      service.persist = null;
      await service.start();
      const job = await service.add({
        name: 'No Persist',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      assert.ok(job.id);
      await service.update(job.id, { name: 'Still Works' });
      assert.strictEqual(service.get(job.id).name, 'Still Works');
      await service.remove(job.id);
      assert.strictEqual(service.get(job.id), null);
    });
  });
});
