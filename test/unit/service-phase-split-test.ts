/**
 * Issue #34 — take the consumer callback out of the critical section.
 *
 * `executeJob` awaits `this.onJobDue(job)` — arbitrary, unbounded consumer
 * code — while `onTimer` holds the module-global lock. A callback that never
 * settles therefore poisons the lock chain permanently and wedges every
 * subsequent `locked()` call (add/update/remove).
 *
 * Separately, `run()` executes without detaching the job from the heap first,
 * so every manual run permanently duplicates the heap entry.
 *
 * House pattern per `.claude/testing.md`: sinon fake timers with
 * `shouldAdvanceTime: false`. No real timers, no sleeps. Hang probes float the
 * promise rather than awaiting it, then assert a settled-flag after
 * `clock.tickAsync(0)` — so a hung path produces a clean assertion failure
 * rather than a runner timeout.
 *
 * HARNESS TRAP (from the issue): a test must advance the clock past
 * `nextRunAtMs` so `armTimer` fires `onTimer` naturally. Calling `onTimer()`
 * directly without advancing makes `findDueJobs` return `[]`, so `onJobDue` is
 * never called, nothing hangs, and the test passes against the UNFIXED code.
 * Every hang test here therefore carries a `precondition:` assertion proving a
 * callback is genuinely in flight.
 *
 * Heap assertions are key-scoped (`items.filter(i => i.key === job.id)`),
 * never `items.length`.
 *
 * ASSERTION LABELLING: `precondition:` marks a setup check that proves the test
 * is not vacuous. `guard:` marks an assertion that also passes against the
 * pre-fix tree — present so a later change cannot silently break the property,
 * not as evidence for this one. No test here rests on a `guard:` alone.
 */
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import log from 'stonyx/log';
import { setupIntegrationTests } from 'stonyx/test-helpers';
import CronService from '../../src/service.js';
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

/**
 * Float a promise and report whether it has settled, without ever awaiting it.
 * A hung path then produces a clean assertion failure, never a runner timeout.
 */
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

/** A promise the test resolves by hand, so a callback can genuinely yield. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
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
    // AC1: with a never-settling onJobDue and a job driven due, add(), update()
    // and remove() all still resolve.
    test('add/update/remove all resolve while onJobDue is still in flight', async function (assert) {
      // Arbitrary consumer code that never settles — the reported live failure
      // mode (a spawned external process that never exits).
      service.onJobDue = () => new Promise<void>(() => {});

      await service.start();
      const hung = await service.add({ name: 'Hung', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      const victim = await service.add({ name: 'Victim', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      // Drive the job due through the real timer path — armTimer fires onTimer
      // naturally. See HARNESS TRAP above.
      await clock.tickAsync(31_000);

      assert.true(service.running, 'precondition: the scheduler is mid-execution');
      assert.ok(service.get(hung.id)?.state.runningAtMs, 'precondition: the hung job is marked running');

      const added = probe(service.add({ name: 'Added During Hang', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } }));
      const updated = probe(service.update(victim.id, { name: 'Updated During Hang' }));
      const removed = probe(service.remove(victim.id));

      await clock.tickAsync(0);

      assert.true(added.settled(), 'add() resolves while the callback is in flight');
      assert.true(updated.settled(), 'update() resolves while the callback is in flight');
      assert.true(removed.settled(), 'remove() resolves while the callback is in flight');
      assert.strictEqual(added.error(), undefined, 'guard: add() resolved rather than rejecting');
      assert.strictEqual(updated.error(), undefined, 'guard: update() resolved rather than rejecting');
      assert.strictEqual(removed.error(), undefined, 'guard: remove() resolved rather than rejecting');
      assert.strictEqual(service.get(victim.id), null, 'the mutation actually applied — victim is gone');
    });
  });

  module('A6 — run() does not duplicate heap entries', function () {
    // AC2: run(id, 'force') twice leaves exactly one heap entry for that job.
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
    // AC3: an onJobDue that calls service.add() and service.update() from
    // inside itself completes, and both mutations apply.
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

      assert.strictEqual(innerError, null, 'guard: no error escaped the inner mutations');
      assert.ok(innerAddId, 'the inner add() resolved from inside the callback');
      assert.true(callbackCompleted, 'the callback ran to completion');
      assert.strictEqual(service.status().jobCount, 2, 'the spawned job was added');
      assert.strictEqual(service.get(job.id)?.name, 'Renamed From Inside', 'the self-update applied');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the self-updated job holds exactly one heap entry');
    });
  });

  module('A4 — run() will not launch a concurrent second invocation', function () {
    // AC4: run(id, 'force') on a job with runningAtMs set returns
    // { status: 'skipped', reason: 'already running' }.
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

      assert.true(second.settled(), 'the second run settles rather than queueing behind the first');
      assert.strictEqual(second.value()?.status, 'skipped', 'second run reports skipped');
      assert.strictEqual(second.value()?.reason, 'already running', 'second run reports "already running"');
      assert.strictEqual(invocations, 1, 'the callback was not re-entered concurrently');
    });
  });

  module('restart — a stale claim must not rehydrate a permanently dead job', function () {
    test('start(initialJobs) clears a runningAtMs left behind by a crash mid-flight', async function (assert) {
      // Produce exactly the state a crash between claim and settle leaves in a
      // consumer's store: claimed, never settled. Nothing reaps it — there is no
      // lease on `runningAtMs` — so rehydrating it verbatim yields a job that is
      // dead forever while `status()` reports it healthy: `isDue` is false
      // because of the flag, `run()` answers 'already running' every time, and
      // `update()` never touches the field. Same hazard the 'removed' early
      // return in `#executeClaimed` already releases by hand.
      const crashed = new CronService();
      crashed.onJobDue = () => new Promise<void>(() => {});
      await crashed.start();
      const job = await crashed.add({ name: 'Crashed Mid Flight', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

      await clock.tickAsync(31_000);
      assert.ok(job.state.runningAtMs, 'precondition: the claim is recorded on the object a store would persist');
      crashed.stop();

      // Restart against the same object, exactly as start(initialJobs) gets it.
      let invoked = 0;
      service.onJobDue = () => { invoked++; return { status: 'ok' }; };
      await service.start([job]);

      assert.strictEqual(job.state.runningAtMs, undefined, 'the stale claim was cleared on rehydration');

      const manual = await service.run(job.id, 'force');
      assert.strictEqual(manual.status, 'ok', 'run() is not refused with "already running"');
      assert.strictEqual(invoked, 1, 'the callback actually fired after the restart');

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);
      assert.true(invoked >= 2, 'the timer path fires the rehydrated job too');
    });
  });

  module('claim/settle integrity — a claim always gets a settle', function () {
    // Supporting coverage for AC5: the split must not be able to strand a job
    // off the heap with runningAtMs set, on any exit path.
    test('a throwing callback still settles, and its batch siblings still run', async function (assert) {
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

        assert.deepEqual(invoked, ['Thrower', 'Sibling'], 'one job throwing does not abort the rest of the batch');
        assert.deepEqual(rejections.seen(), [], 'nothing escaped as an unhandled rejection');

        assert.strictEqual(service.get(thrower.id)?.state.runningAtMs, undefined, 'the thrower settled — runningAtMs was cleared');
        assert.strictEqual(service.get(thrower.id)?.state.lastStatus, 'error', 'the thrower settled with an error status');
        assert.strictEqual(heapEntriesFor(service, thrower.id), 1, 'the thrower is back on the heap and will run again');

        assert.strictEqual(service.get(sibling.id)?.state.runningAtMs, undefined, 'the sibling settled — runningAtMs was cleared');
        assert.strictEqual(heapEntriesFor(service, sibling.id), 1, 'the sibling is back on the heap');

        assert.false(service.running, 'guard: the scheduler released its re-entrancy latch');
      } finally {
        rejections.restore();
      }
    });

    test('settle still runs when the phase-2 error reporter itself throws', async function (assert) {
      const rejections = captureUnhandledRejections();
      // BOTH reporting channels fail. `log()` is a public, overridable method
      // that reaches a transport, so it is a real second failure source inside
      // the phase-2 catch handler; `log.error` is the ungated channel the
      // per-job handler reports on, and its transports reach the filesystem
      // too. This falsifies "settle as a trailing statement": with phase 3 not
      // in a `finally`, any throw here skips it and permanently strands the
      // claim — off the heap, `runningAtMs` set, `isDue` false forever.
      // Rejects ASYNCHRONOUSLY, matching the real shape. `log.error` is a
      // chronicle convenience method onto `async log(...)`, so every failure it
      // can have is a rejection. A `.throws()` stub here is a synchronous stand-in
      // for an asynchronous thing — the same defect class this PR fixes for
      // `onJobDue` — and it leaves the assertion at the bottom of this test
      // incapable of failing, because the escaping rejection it exists to catch
      // is the one the stub cannot produce.
      const errorLog = sinon.stub(log, 'error').callsFake(async () => {
        throw new Error('error transport exploded');
      });

      try {
        service.log = () => { throw new Error('log transport exploded'); };
        service.onJobDue = () => { throw new Error('callback blew up'); };

        await service.start();
        const job = await service.add({ name: 'Log Explodes', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

        await clock.tickAsync(31_000);
        await clock.tickAsync(0);

        assert.true(errorLog.called, 'precondition: the ungated per-job error reporter was reached');
        assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'settle ran despite a non-local exit from phase 2');
        assert.strictEqual(service.get(job.id)?.state.lastStatus, 'error', 'the error result was still applied');
        assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the job is back on the heap');
        assert.false(service.running, 'guard: the scheduler released its re-entrancy latch');
        assert.deepEqual(rejections.seen(), [], 'nothing escaped as an unhandled rejection');
      } finally {
        errorLog.restore();
        rejections.restore();
      }
    });

    test('the ungated reporter throwing SYNCHRONOUSLY is contained too', async function (assert) {
      // The sibling of the test above. `log` is a shared, consumer-reachable
      // singleton, so the reporter can fail in either direction: a rejection
      // out of chronicle's `async log`, or a synchronous throw from a replaced
      // method or from evaluating the template literal. The call site needs a
      // `try` AND a `.catch()`; this test is the half that guards the `try`.
      const errorLog = sinon.stub(log, 'error').throws(new Error('error transport exploded synchronously'));

      try {
        service.log = () => { throw new Error('log transport exploded'); };
        service.onJobDue = () => { throw new Error('callback blew up'); };

        await service.start();
        const job = await service.add({ name: 'Sync Log Explodes', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

        await clock.tickAsync(31_000);
        await clock.tickAsync(0);

        assert.true(errorLog.called, 'precondition: the ungated per-job error reporter was reached');
        assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'settle ran despite the reporter throwing');
        assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the job is back on the heap');
        assert.false(service.running, 'the scheduler released its re-entrancy latch');
      } finally {
        errorLog.restore();
      }
    });

    test('a yielding callback is observably in flight, holding no lock and no heap entry', async function (assert) {
      // The existing-test audit in #34 measured that EVERY execution test sets
      // onJobDue to a synchronous function, so the lock's critical section is
      // never entered and `service.running` is never observed true. This is the
      // committed test that drives a callback which genuinely yields.
      const gate = deferred();
      let invoked = 0;

      service.onJobDue = () => { invoked++; return gate.promise; };

      await service.start();
      const job = await service.add({ name: 'Yielder', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

      await clock.tickAsync(31_000);

      assert.strictEqual(invoked, 1, 'precondition: the callback was invoked');
      assert.true(service.running, 'precondition: the scheduler is mid-execution');
      assert.ok(service.get(job.id)?.state.runningAtMs, 'the claim phase marked the job running');
      assert.strictEqual(heapEntriesFor(service, job.id), 0, 'the claim phase detached the job from the heap');

      // The lock is genuinely free while the callback is in flight.
      const midFlight = probe(service.add({ name: 'Mid Flight', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } }));
      await clock.tickAsync(0);
      assert.true(midFlight.settled(), 'a locked() mutation resolves while the callback yields');

      gate.resolve();
      await clock.tickAsync(0);

      assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'settle released the claim');
      assert.strictEqual(service.get(job.id)?.state.lastStatus, 'ok', 'settle applied the result');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'settle re-inserted exactly one heap entry');
      assert.false(service.running, 'the scheduler released its re-entrancy latch');
    });
  });
});
