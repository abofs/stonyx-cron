/**
 * Integration test — advanced CronService API.
 *
 * Demonstrates the full scheduling system: three schedule kinds, CRUD,
 * AI input normalization, error backoff, one-shot semantics, and run history.
 */
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import CronService from '../../src/service.js';
import { normalizeJobInput, recoverFlatParams } from '../../src/normalize.js';
import { resetLock } from '../../src/locked.js';
import { definitions } from '../sample/payload.js';

const { module, test } = QUnit;

module('[Integration] Advanced Scheduling', function (hooks) {
  let service: CronService;
  let clock: SinonFakeTimers;

  hooks.beforeEach(function () {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false, now: new Date('2026-06-15T12:00:00Z') });
    service = new CronService();
  });

  hooks.afterEach(function () {
    service.stop();
    clock.restore();
    resetLock();
  });

  // ── Schedule Kinds ────────────────────────────────────────

  module('schedule kinds', function () {
    test('every: recurring interval job', async function (assert) {
      await service.start();
      const job = await service.add(definitions.everyMinute);

      assert.strictEqual(job.name, 'Every Minute Check');
      assert.strictEqual(job.schedule.kind, 'every');
      if ('everyMs' in job.schedule) assert.strictEqual(job.schedule.everyMs, 60_000);
      assert.ok(job.state.nextRunAtMs, 'next run computed');
    });

    test('cron: expression-based schedule', async function (assert) {
      await service.start();
      const job = await service.add(definitions.dailyMorning);

      assert.strictEqual(job.schedule.kind, 'cron');
      if ('expr' in job.schedule) assert.strictEqual(job.schedule.expr, '0 9 * * *');
      if ('tz' in job.schedule) assert.strictEqual(job.schedule.tz, 'America/New_York');
      assert.ok(job.state.nextRunAtMs, 'next run computed from cron expression');
    });

    test('at: one-shot with auto deleteAfterRun', async function (assert) {
      await service.start();
      const job = await service.add(definitions.oneShot);

      assert.strictEqual(job.schedule.kind, 'at');
      assert.strictEqual(job.deleteAfterRun, true, 'auto-set for one-shot');
    });
  });

  // ── CRUD Workflow ─────────────────────────────────────────

  module('CRUD workflow', function () {
    test('add → get → update → list → remove', async function (assert) {
      await service.start();

      // Add
      const job = await service.add(definitions.everyMinute);
      assert.strictEqual(service.status().jobCount, 1);

      // Get
      assert.deepEqual(service.get(job.id), job);

      // Update
      const updated = await service.update(job.id, { name: 'Renamed' });
      assert.strictEqual(updated.name, 'Renamed');

      // List
      const jobs = service.list();
      assert.strictEqual(jobs.length, 1);
      assert.strictEqual(jobs[0].name, 'Renamed');

      // Remove
      await service.remove(job.id);
      assert.strictEqual(service.status().jobCount, 0);
      assert.strictEqual(service.get(job.id), null);
    });

    test('list filters disabled by default', async function (assert) {
      await service.start();
      await service.add(definitions.everyMinute);
      await service.add(definitions.disabled);

      assert.strictEqual(service.list().length, 1, 'disabled hidden by default');
      assert.strictEqual(service.list({ includeDisabled: true }).length, 2, 'includeDisabled shows all');
    });
  });

  // ── Normalization ─────────────────────────────────────────

  module('AI input normalization', function () {
    test('flat params from AI are recovered', async function (assert) {
      await service.start();
      const job = await service.add(definitions.aiFlat);

      assert.strictEqual(job.schedule.kind, 'every');
      if ('everyMs' in job.schedule) assert.strictEqual(job.schedule.everyMs, 120000);
      assert.strictEqual(job.payload.kind, 'agentTurn');
      assert.strictEqual(job.payload.message, 'check the weather');
    });

    test('sessionTarget inferred from payload kind', async function (assert) {
      await service.start();
      const agent = await service.add(definitions.everyMinute);
      assert.strictEqual(agent.sessionTarget, 'isolated');

      const sys = await service.add(definitions.systemEvent);
      assert.strictEqual(sys.sessionTarget, 'main');
    });

    test('delivery auto-set for isolated agentTurn', async function (assert) {
      await service.start();
      const job = await service.add(definitions.everyMinute);
      assert.deepEqual(job.delivery, { mode: 'announce' });
    });
  });

  // ── Execution ─────────────────────────────────────────────

  module('execution', function () {
    test('timer fires due job', async function (assert) {
      const executed: string[] = [];
      service.onJobDue = (job) => {
        executed.push(job.name);
        return { status: 'ok', summary: 'done' };
      };

      await service.start();
      await service.add(definitions.everyMinute);

      await clock.tickAsync(61_000);

      assert.deepEqual(executed, ['Every Minute Check']);
    });

    test('manual run with force bypasses schedule', async function (assert) {
      let ran = false;
      service.onJobDue = () => { ran = true; return { status: 'ok' }; };

      await service.start();
      const job = await service.add({
        name: 'Far Future',
        schedule: { kind: 'every', everyMs: 86_400_000 },
        payload: { kind: 'agentTurn', message: 'go' },
      });

      await service.run(job.id, 'force');
      assert.ok(ran, 'executed despite not being due');
    });

    test('one-shot deletion after successful run', async function (assert) {
      service.onJobDue = () => ({ status: 'ok' });

      await service.start();
      const job = await service.add(definitions.oneShot);

      const result = await service.run(job.id);
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.deleted, true);
      assert.strictEqual(service.get(job.id), null);
    });

    test('error backoff increases consecutiveErrors', async function (assert) {
      service.onJobDue = () => { throw new Error('fail'); };

      await service.start();
      const job = await service.add(definitions.everyMinute);

      await service.run(job.id);
      assert.strictEqual(job.state.consecutiveErrors, 1);
      assert.ok(job.state.nextRunAtMs! >= Date.now() + 25_000, 'backoff applied');
    });
  });

  // ── Run History ───────────────────────────────────────────

  module('run history', function () {
    test('runs() returns execution log', async function (assert) {
      service.onJobDue = () => ({ status: 'ok', summary: 'done' });

      await service.start();
      const job = await service.add(definitions.everyMinute);

      await service.run(job.id);
      await service.run(job.id);

      const history = service.runs(job.id);
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].status, 'ok');
      assert.ok(history[0].ts, 'entries have timestamps');
    });
  });

  // ── Status ────────────────────────────────────────────────

  module('status', function () {
    test('reports running state and job count', async function (assert) {
      await service.start();
      const s1 = service.status();
      assert.strictEqual(s1.started, true);
      assert.strictEqual(s1.jobCount, 0);

      await service.add(definitions.everyMinute);
      const s2 = service.status();
      assert.strictEqual(s2.jobCount, 1);
      assert.ok(s2.nextWakeAtMs, 'next wake time set');
    });
  });
});
