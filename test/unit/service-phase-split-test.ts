/**
 * Issue #34a — take the consumer callback out of the critical section.
 *
 * `executeJob` used to `await this.onJobDue(job)` — arbitrary, unbounded
 * consumer code — while `onTimer` held the module-global lock. A callback
 * that never settles therefore poisoned the lock chain permanently and
 * wedged every subsequent `locked()` call (add/update/remove).
 *
 * Separately, `run()` executed without detaching the job from the heap
 * first, so every manual run permanently duplicated the heap entry.
 *
 * House pattern per `.claude/testing.md`: sinon fake timers with
 * `shouldAdvanceTime: false`. No real timers, no sleeps. Hang probes float
 * the promise rather than awaiting it, then assert a settled-flag after
 * `clock.tickAsync(0)` — so a hung path produces a clean assertion failure
 * rather than a runner timeout.
 *
 * Heap assertions are key-scoped (`items.filter(i => i.key === job.id)`),
 * never `items.length`.
 */
import QUnit from 'qunit';
import { readFileSync } from 'fs';
import sinon, { type SinonFakeTimers } from 'sinon';
import config from 'stonyx/config';
import log from 'stonyx/log';
import { setupIntegrationTests } from 'stonyx/test-helpers';
import CronService from '../../src/service.js';
import type { Job } from '../../src/job.js';
import { resetLock } from '../../src/locked.js';

const { module, test } = QUnit;

type RunResult = Awaited<ReturnType<CronService['run']>>;

const EVERY_30S = { kind: 'every', everyMs: 30_000 } as const;
const EVERY_HOUR = { kind: 'every', everyMs: 3_600_000 } as const;
const PAYLOAD = { kind: 'agentTurn', message: 'go' };

/** Number of heap entries carrying this job's key. */
function heapEntriesFor(service: CronService, id: string): number {
  return service.heap.items.filter(item => item.key === id).length;
}

/** Float a promise and report whether it has settled, without ever awaiting it. */
function probe<T>(promise: Promise<T>): { settled: () => boolean; value: () => T | undefined; error: () => unknown } {
  let done = false;
  let value: T | undefined;
  let error: unknown;

  promise.then(
    result => { done = true; value = result; },
    err => { done = true; error = err; },
  );

  return { settled: () => done, value: () => value, error: () => error };
}

/**
 * Reproduce the production logging environment inside the suite.
 *
 * `test/config/environment.ts` sets `cron: { log: false }`, so `CronService.log`
 * early-returns in all 147 pre-existing tests and its body has zero coverage.
 * Production defaults to `log: true` (`config/environment.js`), and `log.cron`
 * only exists once `log.defineType('cron', ...)` has run — which happens in
 * `Cron.init()` (`src/main.ts`), a *different class* that a consumer wiring
 * `CronService` directly never instantiates. `src/types/stonyx.d.ts:19` declares
 * `cron(message: string): void` unconditionally, so the type system actively
 * hides this.
 *
 * Returns a restore function; always call it in a `finally`.
 */
function withProductionLogging(): () => void {
  const previousLogFlag = config.cron.log;
  const logRecord = log as unknown as Record<string, unknown>;
  const hadCron = Object.prototype.hasOwnProperty.call(logRecord, 'cron');
  const previousCron = logRecord.cron;

  config.cron.log = true;
  delete logRecord.cron;

  return () => {
    config.cron.log = previousLogFlag;
    if (hadCron) logRecord.cron = previousCron;
    else delete logRecord.cron;
  };
}

/** Swallow unhandled rejections for the duration of a test and report them. */
function captureUnhandledRejections(): { seen: () => unknown[]; restore: () => void } {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', handler);

  return {
    seen: () => seen,
    restore: () => { process.off('unhandledRejection', handler); },
  };
}

module('CronService — phase split (#34)', function (hooks) {
  setupIntegrationTests(hooks);
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

  module('A3 — a hung callback holds no lock', function () {
    test('add/update/remove all resolve while onJobDue is still in flight', async function (assert) {
      // Arbitrary consumer code that never settles — the live failure mode
      // reported downstream (a spawned external process that hangs).
      service.onJobDue = () => new Promise<void>(() => {});

      await service.start();
      const hung = await service.add({ name: 'Hung', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      const victim = await service.add({ name: 'Victim', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      // Drive the job due through the real timer path — armTimer fires
      // onTimer naturally. Calling onTimer() directly without advancing the
      // clock would make findDueJobs return [] and the probe vacuous.
      await clock.tickAsync(31_000);

      // Preconditions: a callback is genuinely in flight and unresolved.
      assert.true(service.running, 'precondition: scheduler is mid-execution');
      assert.ok(service.get(hung.id)?.state.runningAtMs, 'precondition: the hung job is marked running');

      const added = probe(service.add({ name: 'Added During Hang', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } }));
      const updated = probe(service.update(victim.id, { name: 'Updated During Hang' }));
      const removed = probe(service.remove(victim.id));

      await clock.tickAsync(0);

      assert.true(added.settled(), 'add() resolves while the callback is in flight');
      assert.true(updated.settled(), 'update() resolves while the callback is in flight');
      assert.true(removed.settled(), 'remove() resolves while the callback is in flight');
      assert.strictEqual(added.error(), undefined, 'add() resolved rather than rejecting');
      assert.strictEqual(updated.error(), undefined, 'update() resolved rather than rejecting');
      assert.strictEqual(removed.error(), undefined, 'remove() resolved rather than rejecting');
      assert.strictEqual(service.get(victim.id), null, 'the mutation actually applied — victim is gone');
    });
  });

  module('A6 — run() does not duplicate heap entries', function () {
    test('run(id, force) twice leaves exactly one heap entry for the job', async function (assert) {
      service.onJobDue = () => ({ status: 'ok' });

      await service.start();
      const job = await service.add({ name: 'Manual', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'precondition: one heap entry after add');

      await service.run(job.id, 'force');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'one heap entry after the first forced run');

      await service.run(job.id, 'force');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'one heap entry after the second forced run');
    });
  });

  module('A9 — a self-mutating callback is no longer reentrant', function () {
    test('onJobDue calling add() and update() on itself completes and both mutations apply', async function (assert) {
      let innerAddId: string | null = null;
      let innerError: string | null = null;
      let callbackCompleted = false;

      service.onJobDue = async (job) => {
        try {
          const spawned = await service.add({ name: 'Spawned', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });
          innerAddId = spawned.id;
          await service.update(job.id, { name: 'Renamed From Inside' });
        } catch (err: unknown) {
          innerError = err instanceof Error ? err.message : String(err);
        }
        callbackCompleted = true;
        return { status: 'ok' };
      };

      await service.start();
      const job = await service.add({ name: 'Self Mutating', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);

      assert.strictEqual(innerError, null, 'no error escaped the inner mutations');
      assert.ok(innerAddId, 'the inner add() resolved from inside the callback');
      assert.true(callbackCompleted, 'the callback ran to completion');
      assert.strictEqual(service.status().jobCount, 2, 'the spawned job was added');
      assert.strictEqual(service.get(job.id)?.name, 'Renamed From Inside', 'the self-update applied');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the self-updated job holds exactly one heap entry');
    });
  });

  module('A4 — run() will not launch a concurrent second invocation', function () {
    test('run(id, force) on a job with runningAtMs returns skipped/already running', async function (assert) {
      let invocations = 0;
      service.onJobDue = () => {
        invocations++;
        return new Promise<void>(() => {});
      };

      await service.start();
      const job = await service.add({ name: 'Long Runner', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const first = probe(service.run(job.id, 'force'));
      await clock.tickAsync(0);

      assert.strictEqual(invocations, 1, 'precondition: the first run invoked the callback');
      assert.false(first.settled(), 'precondition: the first run has not settled');
      assert.ok(service.get(job.id)?.state.runningAtMs, 'precondition: runningAtMs is set by the claim phase');

      const second = probe<RunResult>(service.run(job.id, 'force'));
      await clock.tickAsync(0);

      assert.true(second.settled(), 'the second run settles rather than hanging behind the first');
      assert.strictEqual(second.value()?.status, 'skipped', 'second run reports skipped');
      assert.strictEqual(second.value()?.reason, 'already running', 'second run reports "already running"');
      assert.strictEqual(invocations, 1, 'the callback was not re-entered concurrently');
    });
  });

  module('BLOCKER — a claim always gets a settle', function () {
    test('a throwing callback with production logging enabled still settles, and its batch siblings still run', async function (assert) {
      const restoreLogging = withProductionLogging();
      const rejections = captureUnhandledRejections();
      const invoked: string[] = [];

      try {
        service.onJobDue = (job) => {
          invoked.push(job.name);
          if (job.name === 'Thrower') throw new Error('callback blew up');
          return { status: 'ok' };
        };

        await service.start();
        const thrower = await service.add({ name: 'Thrower', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
        const sibling = await service.add({ name: 'Sibling', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

        await clock.tickAsync(31_000);
        await clock.tickAsync(0);

        assert.deepEqual(rejections.seen(), [], 'nothing escaped as an unhandled rejection');
        assert.deepEqual(invoked, ['Thrower', 'Sibling'], 'one job throwing does not abort the rest of the batch');

        assert.strictEqual(service.get(thrower.id)?.state.runningAtMs, undefined, 'the thrower settled — runningAtMs was cleared');
        assert.strictEqual(service.get(thrower.id)?.state.lastStatus, 'error', 'the thrower settled with an error status');
        assert.strictEqual(heapEntriesFor(service, thrower.id), 1, 'the thrower is back on the heap and will run again');

        assert.strictEqual(service.get(sibling.id)?.state.runningAtMs, undefined, 'the sibling settled — runningAtMs was cleared');
        assert.strictEqual(heapEntriesFor(service, sibling.id), 1, 'the sibling is back on the heap');

        assert.false(service.running, 'the scheduler released its re-entrancy latch');
      } finally {
        rejections.restore();
        restoreLogging();
      }
    });

    test('run() with production logging enabled does not permanently unschedule a job whose callback throws', async function (assert) {
      const restoreLogging = withProductionLogging();
      const rejections = captureUnhandledRejections();

      try {
        service.onJobDue = () => { throw new Error('callback blew up'); };

        await service.start();
        const job = await service.add({ name: 'Manual Thrower', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

        assert.strictEqual(heapEntriesFor(service, job.id), 1, 'precondition: armed with one heap entry');

        const result = probe<RunResult>(service.run(job.id, 'force'));
        await clock.tickAsync(0);

        assert.true(result.settled(), 'run() settled');
        assert.strictEqual(result.error(), undefined, 'run() resolved rather than rejecting');
        assert.strictEqual(result.value()?.status, 'error', 'run() reported the callback error');
        assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'the claim was released');
        assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the job is still scheduled — the claim did not strand it off the heap');
        assert.deepEqual(rejections.seen(), [], 'nothing escaped as an unhandled rejection');
      } finally {
        rejections.restore();
        restoreLogging();
      }
    });

    test('settle still runs when the error-reporting path itself throws', async function (assert) {
      const rejections = captureUnhandledRejections();

      try {
        // `log()` is a public, overridable method that can reach a file
        // transport, so it is a real second failure source inside the catch
        // handler — the exact shape the `log.cron` defect took. This falsifies
        // the try/finally on its own: with settle as a trailing statement, ANY
        // throw here skips phase 3 and permanently strands the claim.
        service.log = () => { throw new Error('log transport exploded'); };
        service.onJobDue = () => { throw new Error('callback blew up'); };

        await service.start();
        const job = await service.add({ name: 'Log Explodes', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

        await clock.tickAsync(31_000);
        await clock.tickAsync(0);

        assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'settle ran despite a non-local exit from phase 2');
        assert.strictEqual(service.get(job.id)?.state.lastStatus, 'error', 'the error result was still applied');
        assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the job is back on the heap');
        assert.false(service.running, 'the scheduler released its re-entrancy latch');
      } finally {
        rejections.restore();
      }
    });

    test('a callback throwing an unstringifiable value is recorded as an error, not a crash', async function (assert) {
      // `err instanceof Error` is false for a null-prototype object, so the
      // catch handler falls through to `String(err)` — which throws
      // "Cannot convert object to primitive value". The error handler must be
      // total; a consumer callback can throw any value at all.
      service.onJobDue = () => { throw Object.create(null) as never; };

      await service.start();
      const job = await service.add({ name: 'Unstringifiable', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const result = probe<RunResult>(service.run(job.id, 'force'));
      await clock.tickAsync(0);

      assert.true(result.settled(), 'run() settled');
      assert.strictEqual(result.error(), undefined, 'run() resolved rather than rejecting');
      assert.strictEqual(result.value()?.status, 'error', 'the throw was reported as an error result');
      assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'the claim was released');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the job is still scheduled');
    });
  });

  module('CRITICAL — a resolved remove() means the callback will not fire', function () {
    test('a job removed by a sibling callback is not invoked later in the same batch', async function (assert) {
      // `onTimer` batch-claims every due job under one lock, then invokes them
      // serially and UNLOCKED. A sibling callback calling remove() therefore
      // resolves — that call used to deadlock — and the loop, which re-reads
      // nothing, invokes the removed job anyway. Newly reachable, same root
      // cause as the self-removal case already guarded in settleJob.
      const fired: string[] = [];
      let bId = '';

      service.onJobDue = async (job) => {
        fired.push(job.name);
        if (job.name === 'A') await service.remove(bId);
        return { status: 'ok' };
      };

      await service.start();
      await service.add({ name: 'A', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      const b = await service.add({ name: 'B', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      bId = b.id;

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);

      assert.deepEqual(fired, ['A'], 'B was not invoked after being removed mid-batch');
      assert.strictEqual(service.get(bId), null, 'B stays removed');
      assert.strictEqual(heapEntriesFor(service, bId), 0, 'no heap entry for removed B');
      assert.strictEqual(service.runs(bId).length, 0, 'no run-log entry for removed B');
    });
  });

  module('HIGH — a stale settle must not clobber a replacement', function () {
    test('settling a job whose id was re-registered leaves the replacement scheduled', async function (assert) {
      // The settle guard compares object identity (correct) but removed from
      // the heap BY ID — so a stale settle deleted the replacement's entry.
      // Reachable through the documented store-rehydration path:
      // stop() then start(initialJobs) re-registers the same id.
      let release: (() => void) | undefined;
      service.onJobDue = () => new Promise<void>(resolve => { release = () => resolve(); });

      await service.start();
      const job = await service.add({ name: 'Original', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const inFlight = probe<RunResult>(service.run(job.id, 'force'));
      await clock.tickAsync(0);
      assert.ok(service.get(job.id)?.state.runningAtMs, 'precondition: the original is claimed and in flight');

      await service.remove(job.id);

      const replacement: Job = {
        ...job,
        name: 'Replacement',
        state: { ...job.state, runningAtMs: undefined, nextRunAtMs: Date.now() + 3_600_000 },
      };
      service.stop();
      await service.start([replacement]);

      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'precondition: the replacement is armed with one heap entry');

      release?.();
      await clock.tickAsync(0);

      assert.true(inFlight.settled(), 'the original run settled');
      assert.strictEqual(service.get(job.id), replacement, 'the replacement is still the registered job');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the stale settle did not remove the replacement heap entry');
      assert.strictEqual(service.status().nextWakeAtMs, replacement.state.nextRunAtMs, 'the scheduler still wakes for the replacement');
    });
  });

  module('HIGH — the claim guard is not bypassable from the published surface', function () {
    test('a second executeJob() cannot skip the claim phase, even with an extra argument', async function (assert) {
      // `alreadyClaimed` was an internal onTimer<->executeJob coordination
      // detail, but it shipped in `dist/service.d.ts` as a plain untagged
      // boolean on the published "./service" subpath. Passing `true` skipped
      // phase 1 wholesale, so claimJob's runningAtMs check never ran and
      // `onJobDue` could be invoked concurrently for the same job — exactly
      // what AC4 forbids.
      let invocations = 0;
      service.onJobDue = () => { invocations++; return new Promise<void>(() => {}); };

      await service.start();
      const job = await service.add({ name: 'Long Runner', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const first = probe<RunResult>(service.run(job.id, 'force'));
      await clock.tickAsync(0);
      assert.strictEqual(invocations, 1, 'precondition: the first invocation is in flight');
      assert.false(first.settled(), 'precondition: the first invocation has not settled');

      const bypass = probe<RunResult>(
        (service.executeJob as (j: Job, alreadyClaimed?: boolean) => Promise<RunResult>)(job, true),
      );
      await clock.tickAsync(0);

      assert.strictEqual(invocations, 1, 'the claim guard cannot be bypassed from the published surface');
      assert.true(bypass.settled(), 'the bypass attempt settled rather than launching a second invocation');
      assert.strictEqual(bypass.value()?.reason, 'already running', 'the bypass attempt was refused by the claim phase');
    });

    test('the pre-claimed path is not in the published type surface', function (assert) {
      // Not a guard: this fails against head, where dist/service.d.ts carries
      // `executeJob(job: Job, alreadyClaimed?: boolean)`.
      const declaration = readFileSync(new URL('../../dist/service.d.ts', import.meta.url), 'utf8');
      const declarations = declaration.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      assert.notOk(/alreadyClaimed/.test(declarations), 'dist/service.d.ts declares no alreadyClaimed parameter');
      assert.ok(/executeJob\(job: Job\): Promise/.test(declarations), 'executeJob publishes a single-parameter signature');
      assert.ok(/#private;/.test(declarations), 'the pre-claimed entry point is emitted as #private, not as a callable member');
    });

    test('claimJob refuses a job removed between run()\'s lookup and the lock turn', async function (assert) {
      // run() reads `this.jobs.get(id)` unlocked, then claims under the lock.
      // A remove() queued first resolves in between, so the claim would
      // otherwise markRunning an orphan and removeFromHeap an id that may
      // already belong to a replacement.
      service.onJobDue = () => ({ status: 'ok' });

      await service.start();
      const job = await service.add({ name: 'Racing Removal', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const removal = probe(service.remove(job.id));
      const result = probe<RunResult>(service.run(job.id, 'force'));
      await clock.tickAsync(0);

      assert.true(removal.settled(), 'precondition: the removal resolved');
      assert.true(result.settled(), 'run() settled');
      assert.strictEqual(result.value()?.status, 'skipped', 'run() reported a skip');
      assert.strictEqual(result.value()?.reason, 'removed', 'run() reported reason "removed"');
      assert.strictEqual(service.get(job.id), null, 'the job stays removed');
    });
  });

  module('regression guards', function () {
    // GUARD — passes against dev too. Present so the phase split cannot
    // silently break the happy path it refactors.
    test('guard: the timer path still executes a due job and leaves a single heap entry', async function (assert) {
      const executed: string[] = [];
      service.onJobDue = async (job) => {
        await Promise.resolve(); // genuinely yields — the lock's critical section is entered for real
        executed.push(job.name);
        return { status: 'ok' };
      };

      await service.start();
      const job = await service.add({ name: 'Timer Guard', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);

      assert.deepEqual(executed, ['Timer Guard'], 'guard: the callback fired exactly once via the timer');
      assert.strictEqual(service.get(job.id)?.state.lastStatus, 'ok', 'guard: the result was applied to the job');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'guard: exactly one heap entry after settle');
      assert.false(service.running, 'guard: the scheduler released and re-armed');
    });

    test('a job removed by its own callback is not resurrected by the settle phase', async function (assert) {
      let innerRemoveSettled = false;
      let innerError: string | null = null;

      service.onJobDue = async (job) => {
        try {
          await service.remove(job.id);
          innerRemoveSettled = true;
        } catch (err: unknown) {
          innerError = err instanceof Error ? err.message : String(err);
        }
        return { status: 'ok' };
      };

      await service.start();
      const job = await service.add({ name: 'Removed Mid Flight', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);

      assert.strictEqual(innerError, null, 'the inner remove() did not error');
      assert.true(innerRemoveSettled, 'the inner remove() resolved from inside the callback');
      assert.strictEqual(service.get(job.id), null, 'the job stays removed');
      assert.strictEqual(service.status().jobCount, 0, 'no job was resurrected');
      assert.strictEqual(heapEntriesFor(service, job.id), 0, 'settle left no heap entry for the removed job');
      assert.strictEqual(service.runs(job.id).length, 0, 'settle left no run-log entry for the removed job');
    });
  });
});
