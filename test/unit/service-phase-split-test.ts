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
 * ASSERTION LABELLING — three labels, and the distinction between the first two
 * is measured, not asserted:
 *
 *   `precondition:` a setup check that proves the test is not vacuous AND that
 *     PASSES IN THE RED RUN against the pre-fix tree. This is the label a
 *     reviewer leans on to rule out the harness trap, so it has to mean exactly
 *     that: if it failed red, the assertions after it would carry no
 *     information about what the fix changed. MEASURED against dev's
 *     `src/service.ts`: all 23 hold in the red run.
 *
 *   `reached:` a non-vacuity check for a code path that DID NOT EXIST before
 *     the fix, so it necessarily fails in the red run. Same job as a
 *     `precondition:` — it proves the assertions after it are not vacuously
 *     true — but it is not evidence of a pre-fix property and must not be
 *     counted as one. Six assertions carry it.
 *
 *   `guard:` an assertion that also passes against the pre-fix tree — present
 *     so a later change cannot silently break the property, not as evidence for
 *     this one. No test here rests on a `guard:` alone.
 */
import QUnit from 'qunit';
import sinon, { type SinonFakeTimers } from 'sinon';
import config from 'stonyx/config';
import log from 'stonyx/log';
import { setupIntegrationTests } from 'stonyx/test-helpers';
import CronService from '../../src/service.js';
import type { Job } from '../../src/job.js';
import { locked, resetLock } from '../../src/locked.js';

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

/**
 * Pin the config-gated log channel on or off for the duration of one test.
 *
 * `test/config/environment.js` pins `cron.log: false` and it IS applied —
 * stonyx's config loader imports the `${basePath}.js` specifier directly, which
 * is why that file is `.js` and must stay `.js` (#30, guarded by
 * `test/unit/publish-surface-test.ts`). So `service.log()` is a no-op for the
 * whole suite by default.
 *
 * Both directions are pinned explicitly, including the one that agrees with the
 * suite default. A test that merely *reads* the flag and asserts it is `false`
 * is asserting a precondition it did not establish: measured before this
 * helper's `withGatedLoggingDisabled` half existed, the ungated-reporter test
 * below failed its own precondition when this file was run in isolation, and
 * passed in the full suite only because `test/unit/cron-test.ts` writes
 * `config.cron.log = false` and never restores it. A precondition satisfied by
 * another file's leaked state is not a precondition.
 */
function withGatedLogging(enabled: boolean): { restore: () => void } {
  const previous = config.cron.log;
  config.cron.log = enabled;

  return { restore: () => { config.cron.log = previous; } };
}

const withGatedLoggingEnabled = () => withGatedLogging(true);
const withGatedLoggingDisabled = () => withGatedLogging(false);

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

    test('settle drops the entry a self-updating callback pushed, measured BEFORE the next timer pass', async function (assert) {
      // The assertion above is real but its MEASUREMENT POINT is too late.
      // `findDueJobs` pops entries and silently discards any whose job is not
      // due, so a stale duplicate is erased by the next timer pass — and the
      // test's trailing `tickAsync` gives it exactly that pass before it looks.
      // Deleting `#settleJob`'s pre-insert `removeFromHeap` therefore left the
      // whole suite green: the scheduler self-heals faster than the test looks.
      //
      // Two changes make this a genuine measurement. It goes through `run()`,
      // which arms a timer but never fires one, and it asserts with NO trailing
      // tick — so the heap is read at settle time, before anything can heal it.
      let update!: Promise<Job>;

      service.onJobDue = async (job) => {
        // Re-push a heap entry for THIS job while it is claimed and detached.
        // The callback is unlocked, so this genuinely interleaves.
        update = service.update(job.id, { name: 'Renamed From Inside' });
        await update;

        return { status: 'ok' };
      };

      await service.start();
      const job = await service.add({ name: 'Self Updating', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

      const result = await service.run(job.id, 'force');
      await update;

      assert.strictEqual(result.status, 'ok', 'precondition: the run settled normally');
      assert.strictEqual(service.get(job.id)?.name, 'Renamed From Inside', 'precondition: the self-update applied, so it did push an entry');
      assert.strictEqual(
        heapEntriesFor(service, job.id),
        1,
        'exactly one heap entry at settle time — the pre-insert dedup dropped the callback\'s',
      );
    });

    test('a job removed and re-registered under the same id keeps the replacement scheduled', async function (assert) {
      // `#settleJob`'s guard compares IDENTITY, not id. That distinction is
      // invisible while the id simply disappears — an id comparison refuses
      // just the same. It only becomes load-bearing in the shape
      // `start(initialJobs)` uses: the job is removed and a DIFFERENT object is
      // registered under the same id while the original is still in flight. An
      // id comparison would then take the settle branch for the replacement and
      // `removeFromHeap(job.id)` would unschedule a live job that never ran.
      const gate = deferred();

      service.onJobDue = () => gate.promise;

      await service.start();
      const original = await service.add({ name: 'Original', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const run = probe(service.run(original.id, 'force'));
      await clock.tickAsync(0);
      assert.ok(original.state.runningAtMs, 'reached: the claim phase — the original is in flight');

      // Rehydrate a DIFFERENT object under the same id while the original is
      // still in flight — the exact shape `start(initialJobs)` produces when a
      // consumer restarts the service from its own store.
      const replacement: Job = structuredClone(original);
      replacement.name = 'Replacement';

      await service.remove(original.id);
      service.stop();
      await service.start([replacement]);

      assert.strictEqual(replacement.id, original.id, 'precondition: the replacement reuses the id');
      assert.notStrictEqual(replacement, original, 'precondition: it is a different object');
      assert.strictEqual(heapEntriesFor(service, original.id), 1, 'precondition: the replacement is scheduled');
      assert.false(run.settled(), 'precondition: the original run is still in flight');

      gate.resolve();
      await clock.tickAsync(0);

      assert.strictEqual(heapEntriesFor(service, original.id), 1, 'the replacement is still scheduled — the old settle did not unschedule it');
      assert.strictEqual(service.get(original.id), replacement, 'the replacement is the registered job');
      assert.strictEqual(replacement.state.runningAtMs, undefined, 'the replacement was not marked running by the old settle');
      assert.strictEqual(service.runs(original.id).length, 0, 'the old settle wrote no run-log row against the replacement');
      assert.strictEqual(original.state.runningAtMs, undefined, 'the original released its own claim');
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
      assert.ok(service.get(job.id)?.state.runningAtMs, 'reached: the claim phase ran and recorded runningAtMs');

      const second = probe<RunResult>(service.run(job.id, 'force'));
      await clock.tickAsync(0);

      assert.true(second.settled(), 'the second run settles rather than queueing behind the first');
      assert.strictEqual(second.value()?.status, 'skipped', 'second run reports skipped');
      assert.strictEqual(second.value()?.reason, 'already running', 'second run reports "already running"');
      assert.strictEqual(invocations, 1, 'the callback was not re-entered concurrently');
    });
  });

  module("'removed' mid-flight — the state the AC1 fix newly makes reachable", function () {
    // Before this change `remove()` deadlocked behind a hung callback, so
    // "removed while claimed" was unreachable. Making `remove()` resolve is what
    // brings the state into existence, and it is guarded in three separate
    // places — `#claimJob`'s refusal, `#executeClaimed`'s membership re-check
    // plus its hand-release of the claim, and `#settleJob`'s identity guard.
    // Each of the tests below fails if its guard is removed.

    test('run() detaches the heap entry for the duration of a YIELDING callback', async function (assert) {
      // The claim-phase heap detach is what stops manual runs duplicating heap
      // entries (AC2), and A6 cannot see it: A6's callback is synchronous, so
      // `#settleJob`'s own `removeFromHeap` masks a missing detach inside the
      // same turn. The one committed test with a genuine yield goes through the
      // timer path, which batch-claims via `findDueJobs` and never reaches
      // `#claimJob` at all. The uncovered combination is run() + a yield.
      const gate = deferred();
      service.onJobDue = () => gate.promise;

      await service.start();
      const job = await service.add({ name: 'Yielding Manual', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'precondition: one heap entry after add');

      const running = probe(service.run(job.id, 'force'));
      await clock.tickAsync(0);

      assert.false(running.settled(), 'precondition: the callback is genuinely in flight');
      assert.strictEqual(heapEntriesFor(service, job.id), 0, 'the claim phase detached the entry for the whole invocation');

      gate.resolve();
      await clock.tickAsync(0);

      assert.true(running.settled(), 'the run settled');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'settle re-inserted exactly one entry');
    });

    test('a job removed while its own callback is in flight is not resurrected by settle', async function (assert) {
      const gate = deferred();
      service.onJobDue = () => gate.promise;

      await service.start();
      const job = await service.add({ name: 'Removed Mid Flight', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const running = probe(service.run(job.id, 'force'));
      await clock.tickAsync(0);
      assert.ok(job.state.runningAtMs, 'reached: the claim phase — the job is in flight');

      await service.remove(job.id);
      assert.strictEqual(service.get(job.id), null, 'precondition: the remove() resolved rather than deadlocking');

      gate.resolve();
      await clock.tickAsync(0);

      assert.true(running.settled(), 'the run settled');
      assert.strictEqual(job.state.runningAtMs, undefined, 'the claim was released');
      assert.strictEqual(heapEntriesFor(service, job.id), 0, 'settle did not resurrect a heap entry for a deleted job');
      assert.strictEqual(service.runs(job.id).length, 0, 'settle did not resurrect a run-log row for a deleted job');
    });

    test("a job removed by a SIBLING's callback in the same due batch never fires", async function (assert) {
      // The whole due batch is claimed under one lock turn, so B is already
      // marked running and off the heap before A's callback starts. A resolved
      // `remove()` still has to mean "this callback will not fire" — which is
      // `#executeClaimed`'s membership re-check, reached through nothing but
      // plain public API.
      const invoked: string[] = [];
      let victim: Job | null = null;

      service.onJobDue = async (job) => {
        invoked.push(job.name);
        if (job.name === 'A') {
          // Both jobs carry the same nextTrigger, so they are collected by the
          // same `findDueJobs` call and marked running under the same lock turn.
          // Asserting the claim from INSIDE A's callback is what proves it: if B
          // were only picked up by a later timer pass this would be undefined
          // and the test would be measuring the wrong thing entirely.
          assert.ok(victim?.state.runningAtMs, 'precondition: B was claimed by the SAME due batch, before A ran');
          await service.remove(victim!.id);
        }
        return { status: 'ok' };
      };

      await service.start();
      await service.add({ name: 'A', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      victim = await service.add({ name: 'B', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);

      assert.deepEqual(invoked, ['A'], "the removed job's callback must NOT fire");
      assert.strictEqual(victim.state.runningAtMs, undefined, 'the claim on the detached object was released by hand');
      assert.strictEqual(service.get(victim.id), null, 'B stays removed');
      assert.strictEqual(heapEntriesFor(service, victim.id), 0, 'B has no heap entry');
    });

    test("remove() landing between run()'s lookup and its claim refuses the run", async function (assert) {
      // `run()` looks the job up unlocked, then queues for the claim. An
      // external lock holder makes that window deterministic: both the claim and
      // the remove() queue behind it, and `locked()` resolves its own gate in a
      // `finally` before its returned promise settles, so the remove() lands
      // first.
      let invoked = 0;
      service.onJobDue = () => { invoked++; return { status: 'ok' }; };

      await service.start();
      const job = await service.add({ name: 'Raced', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const held = deferred();
      const holder = locked(() => held.promise);
      await clock.tickAsync(0);

      const running = probe<RunResult>(service.run(job.id, 'force'));
      const removed = probe(service.remove(job.id));

      held.resolve();
      await holder;
      await clock.tickAsync(0);

      assert.true(removed.settled(), 'precondition: the remove() resolved');
      assert.true(running.settled(), 'precondition: the run settled rather than hanging');
      assert.strictEqual(invoked, 0, 'the callback never fired for a removed job');
      assert.strictEqual(job.state.runningAtMs, undefined, 'no stranded claim on the detached object');
      assert.deepEqual(
        running.value(),
        { status: 'skipped', reason: 'removed' },
        "the run reports 'removed'",
      );
    });

    test("a claim on a stale object whose id now belongs to a replacement is refused", async function (assert) {
      // `#claimJob`'s `'removed'` refusal is the only guard that fires BEFORE
      // `markRunning` + `removeFromHeap`. Every other removed-path guard runs
      // after the claim has already taken effect, so they can undo the claim but
      // not the heap detach. That makes this guard's one distinctive hazard the
      // one its comment names: `removeFromHeap` works by id, so claiming a stale
      // object whose id has since been re-registered unschedules the LIVE
      // replacement — a job that never ran, silently dropped off the heap, while
      // `get()`/`list()`/`status()` all still report it healthy.
      //
      // Reached through `executeJob`, which is public: `run(id)` cannot express
      // it because it resolves the id through `this.jobs` and would hand back
      // the replacement. Removing the refusal leaves every other assertion here
      // passing and only the heap assertion red, which is the point — the damage
      // is done to a third object that the result value never mentions.
      let invocations = 0;
      service.onJobDue = () => { invocations++; return { status: 'ok' }; };

      await service.start();
      const original = await service.add({ name: 'Original', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const replacement: Job = structuredClone(original);
      replacement.name = 'Replacement';

      await service.remove(original.id);
      service.stop();
      await service.start([replacement]);

      assert.strictEqual(service.get(original.id), replacement, 'precondition: the id now resolves to the replacement');
      assert.notStrictEqual(replacement, original, 'precondition: it is a different object');
      assert.strictEqual(heapEntriesFor(service, original.id), 1, 'precondition: the replacement is scheduled');

      const result = await service.executeJob(original);

      assert.deepEqual(result, { status: 'skipped', reason: 'removed' }, 'the claim was refused');
      assert.strictEqual(invocations, 0, 'the stale object never reached the callback');
      assert.strictEqual(original.state.runningAtMs, undefined, 'the stale object was not marked running');
      assert.strictEqual(
        heapEntriesFor(service, original.id),
        1,
        "the replacement is still scheduled — the refused claim did not removeFromHeap its entry",
      );
      assert.strictEqual(service.runs(original.id).length, 0, 'no run-log row was written against the id');
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

    test('a deep-frozen store row is refused loudly by start(), not accepted and then fatal', async function (assert) {
      // `structuredClone` + `Object.freeze` is an ordinary defensive
      // rehydration, and a frozen row is a type-valid `Job`. It is nonetheless
      // unusable by this class: every execution writes `job.state.runningAtMs`
      // via `markRunning`, so the write in `start()` is not what makes the row
      // fail — it is what makes it fail EARLY, at the store boundary, where the
      // consumer's own `await start(...)` can catch it.
      //
      // The tempting narrowing — only clear the field when it is set — was
      // measured and is worse: it lets a frozen row into the heap, and the
      // TypeError then comes out of `onTimer`'s batch claim instead. That runs
      // from a bare timer callback, so it surfaces as an unhandled rejection and
      // is process-fatal under Node's default. This test is what stops that
      // narrowing from being reintroduced as a "fix".
      const seed = new CronService();
      await seed.start();
      const original = await seed.add({ name: 'Frozen Row', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      seed.stop();

      const row: Job = structuredClone(original);
      Object.freeze(row.state);

      assert.strictEqual(row.state.runningAtMs, undefined, 'precondition: the row is idle');
      assert.true(Object.isFrozen(row.state), 'precondition: the row state is frozen');

      let invoked = 0;
      service.onJobDue = () => { invoked++; return { status: 'ok' }; };

      const started = probe(service.start([row]));
      await clock.tickAsync(0);

      assert.true(started.settled(), 'start() settled rather than hanging');
      assert.ok(started.error(), 'start() rejected at the store boundary, where the caller can catch it');
      assert.strictEqual(heapEntriesFor(service, row.id), 0, 'the unusable row never reached the heap');

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);
      assert.strictEqual(invoked, 0, 'and therefore never reached the timer path, where the same throw would be fatal');
    });

    test('start() arms the timer even when a later store row throws', async function (assert) {
      // `initialJobs` crosses a serialization boundary, so `Job[]` is a
      // compile-time claim about runtime data. A row missing `state` throws
      // mid-loop; without the `finally`, `start()` leaves `started: true` — so
      // it is a no-op from then on — with the earlier rows sitting in the heap
      // and no timer. Same terminal state #53 guards `register` against, and
      // `status()` reports it as healthy.
      const seed = new CronService();
      await seed.start();
      const good = await seed.add({ name: 'Good Row', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      const other = await seed.add({ name: 'Malformed Row', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });
      seed.stop();

      const goodRow: Job = structuredClone(good);
      const badRow = structuredClone(other) as unknown as Record<string, unknown>;
      delete badRow.state;

      let invoked = 0;
      service.onJobDue = () => { invoked++; return { status: 'ok' }; };

      const started = probe(service.start([goodRow, badRow as unknown as Job]));
      await clock.tickAsync(0);

      assert.true(started.settled(), 'precondition: start() settled');
      assert.ok(started.error(), 'precondition: the malformed row rejected start()');
      assert.true(service.started, 'precondition: the service is marked started, so start() is now a no-op');
      assert.strictEqual(heapEntriesFor(service, goodRow.id), 1, 'precondition: the row before the throw was registered and scheduled');

      assert.ok(service.timer, 'the timer is armed despite the throw');

      await clock.tickAsync(31_000);
      await clock.tickAsync(0);
      assert.strictEqual(invoked, 1, 'the surviving job still runs');
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

        assert.true(errorLog.called, 'reached: the ungated per-job error reporter');
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

        assert.true(errorLog.called, 'reached: the ungated per-job error reporter');
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
  module('error reporting is total and log-injection safe', function () {
    // `describeError` and `forLog` are the only things standing between an
    // arbitrary consumer-thrown value and a shared, newline-delimited log sink.
    // Both are new in this PR and both were reachable in branches no test
    // entered: replacing `describeError`'s whole body with `String(err)` left
    // the suite fully green, and the `instanceof Error` branch returned
    // `err.message` unguarded, deferring the coercion to the CALLER's template
    // literal where no guard covers it.

    /** An Error whose `message` getter throws — the unguarded branch's worst case. */
    function errorWithHostileMessage(): Error {
      const err = new Error('placeholder');
      Object.defineProperty(err, 'message', {
        get() { throw new Error('message getter exploded'); },
      });

      return err;
    }

    test('run() returns an error result when the thrown Error has a hostile message', async function (assert) {
      // Pre-fix this REJECTED rather than returning: `describeError` handed back
      // `err.message` unread, and `Job "..." failed: ${error}` coerced it one
      // frame up, outside every try. A caller of run() got a rejected promise
      // where the signature promises an ExecuteResult.
      service.onJobDue = () => { throw errorWithHostileMessage(); };

      await service.start();
      const job = await service.add({ name: 'Hostile', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const result = await service.run(job.id, 'force');

      assert.strictEqual(result.status, 'error', 'run() resolved with an error result instead of rejecting');
      assert.strictEqual(result.error, 'unknown error', 'the undescribable value fell through to the total fallback');
      assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'the claim was still released');
      assert.strictEqual(heapEntriesFor(service, job.id), 1, 'settle still re-inserted exactly one heap entry');
    });

    test('the timer path survives a thrown Error with a hostile message', async function (assert) {
      // Same value on the other path. The ungated per-job reporter interpolates
      // describeError's output directly, so an uncaught coercion here escapes
      // the batch loop's per-job catch is not the point — it would throw while
      // BUILDING the message the catch is trying to report.
      const rejections = captureUnhandledRejections();
      const errorLog = sinon.stub(log, 'error').resolves();

      try {
        service.onJobDue = () => { throw errorWithHostileMessage(); };

        await service.start();
        const job = await service.add({ name: 'Hostile Timer', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

        await clock.tickAsync(31_000);
        await clock.tickAsync(0);

        assert.strictEqual(service.get(job.id)?.state.runningAtMs, undefined, 'the claim was released');
        assert.strictEqual(service.get(job.id)?.state.lastStatus, 'error', 'the failure was recorded');
        assert.strictEqual(heapEntriesFor(service, job.id), 1, 'the job is back on the heap');
        assert.false(service.running, 'the scheduler released its re-entrancy latch');
        assert.deepEqual(rejections.seen(), [], 'no unhandled rejection escaped');
      } finally {
        errorLog.restore();
        rejections.restore();
      }
    });

    test('a non-Error thrown value is described through String()', async function (assert) {
      // The `String(err)` branch. Distinct from the fallback below: this value
      // coerces cleanly, so it must be reported verbatim rather than masked.
      service.onJobDue = () => { throw 'a bare string rejection'; };

      await service.start();
      const job = await service.add({ name: 'Bare', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const result = await service.run(job.id, 'force');

      assert.strictEqual(result.status, 'error', 'the throw was caught');
      assert.strictEqual(result.error, 'a bare string rejection', 'String() described the non-Error value');
    });

    test('a thrown value that cannot be coerced falls back to "unknown error"', async function (assert) {
      // `String(Object.create(null))` raises "Cannot convert object to primitive
      // value" — the third branch, and the reason describeError exists at all.
      service.onJobDue = () => { throw Object.create(null); };

      await service.start();
      const job = await service.add({ name: 'Uncoercible', schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

      const result = await service.run(job.id, 'force');

      assert.strictEqual(result.status, 'error', 'the throw was caught');
      assert.strictEqual(result.error, 'unknown error', 'the uncoercible value fell back rather than throwing');
    });

    test('a newline in the job name cannot forge a second log record', async function (assert) {
      // Chronicle writes `${timestamp} ${content}\n` to a newline-delimited
      // file. `job.name` is unvalidated by `createJob` and `normalize.ts` exists
      // to accept AI-shaped input, so a name carrying CRLF splits one record
      // into two, the second wearing a forged `[timestamp] Cron — ` prefix and
      // indistinguishable from a real success row in logs/error.log.
      const gate = withGatedLoggingEnabled();
      const cronLog = sinon.stub(log, 'cron').resolves();

      try {
        service.onJobDue = () => { throw new Error('boom'); };

        await service.start();
        const job = await service.add({
          name: 'Payroll"\r\n[6/15/2026, 12:00:00 PM] Cron — Job "Payroll" (deadbeef) completed OK',
          schedule: { ...EVERY_HOUR },
          payload: { ...PAYLOAD },
        });

        await service.run(job.id, 'force');

        const failureLines = cronLog.args.map(args => args[0] as string).filter(line => line.includes('failed:'));
        assert.strictEqual(failureLines.length, 1, 'precondition: the gated reporter emitted exactly one failure record');
        const [line] = failureLines;
        assert.strictEqual(line.split('\n').length, 1, 'the emitted record is a single line');
        assert.strictEqual(line.split('\r').length, 1, 'no carriage return survived either');
        assert.true(line.includes('\\n'), 'the newline is preserved for a reader as the literal two characters');
        assert.true(line.includes('Payroll'), 'the name is still legible after flattening');
      } finally {
        cronLog.restore();
        gate.restore();
      }
    });

    test('a newline in the error message cannot forge a second log record', async function (assert) {
      // Same sink, the other untrusted value: an error message is arbitrary
      // consumer-callback text. This one reaches the UNGATED `log.error` on the
      // timer path, which no config flag can suppress.
      const errorLog = sinon.stub(log, 'error').resolves();

      try {
        // Throw from the settle phase so the batch loop's outer reporter runs.
        service.onJobDue = () => ({ status: 'ok' });
        service.runLog.record = () => {
          throw new Error('boom\r\n[6/15/2026, 12:00:00 PM] Cron — Job "Payroll" (deadbeef) completed OK');
        };

        await service.start();
        await service.add({ name: 'Injector', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

        await clock.tickAsync(31_000);
        await clock.tickAsync(0);

        assert.strictEqual(errorLog.callCount, 1, 'reached: the ungated per-job reporter');
        const line = errorLog.firstCall.args[0] as string;
        assert.strictEqual(line.split('\n').length, 1, 'the emitted record is a single line');
        assert.strictEqual(line.split('\r').length, 1, 'no carriage return survived either');
        assert.true(line.includes('\\n'), 'the newline is preserved for a reader as the literal two characters');
      } finally {
        errorLog.restore();
      }
    });

    test('an oversized job name and error message are truncated before reaching the sink', async function (assert) {
      // Length cap: one pathological value must not swamp the file. 120 for the
      // name, 512 for the error, each plus a three-character ellipsis.
      const gate = withGatedLoggingEnabled();
      const cronLog = sinon.stub(log, 'cron').resolves();

      try {
        service.onJobDue = () => { throw new Error('E'.repeat(5_000)); };

        await service.start();
        const job = await service.add({ name: 'N'.repeat(5_000), schedule: { ...EVERY_HOUR }, payload: { ...PAYLOAD } });

        const result = await service.run(job.id, 'force');

        const failureLines = cronLog.args.map(args => args[0] as string).filter(line => line.includes('failed:'));
        assert.strictEqual(failureLines.length, 1, 'precondition: the gated reporter emitted exactly one failure record');
        const [line] = failureLines;
        assert.strictEqual((line.match(/N/g) ?? []).length, 120, 'the name was capped at 120 characters');
        assert.strictEqual((line.match(/E/g) ?? []).length, 512, 'the error text was capped at 512 characters');
        assert.strictEqual(result.error?.length, 5_000, 'the RETURNED error is untruncated — the cap is a log concern only');
      } finally {
        cronLog.restore();
        gate.restore();
      }
    });

    test('the ungated per-job reporter still fires with config.cron.log === false', async function (assert) {
      // The reason `onTimer`'s per-job handler routes around `service.log()` and
      // calls `log.error` directly: `service.log()` early-returns when
      // `config.cron.log` is false, which is a supported production setting, and
      // a silently swallowed batch failure is a permanent unschedule that
      // `status()` reports as healthy. The suite's own config pins that flag
      // false, so this asserts the design rationale against the real state
      // rather than a simulated one.
      // Pinned off HERE, not inherited. The suite default is already `false`,
      // but this test's whole point is the behaviour under that setting, so it
      // establishes it rather than trusting whatever ran before it.
      const gate = withGatedLoggingDisabled();
      const cronLog = sinon.stub(log, 'cron').resolves();
      const errorLog = sinon.stub(log, 'error').resolves();

      try {
        assert.false(Boolean(config.cron.log), 'precondition: the gated channel is off, as production may configure it');

        service.onJobDue = () => { throw new Error('gated off, still reported'); };

        await service.start();
        await service.add({ name: 'Silent', schedule: { ...EVERY_30S }, payload: { ...PAYLOAD } });

        // The settle-phase reporter is the gated one; force the batch-loop
        // reporter by throwing out of settle itself.
        service.runLog.record = () => { throw new Error('settle exploded'); };

        await clock.tickAsync(31_000);
        await clock.tickAsync(0);

        assert.strictEqual(cronLog.callCount, 0, 'the gated channel emitted nothing, as configured');
        assert.strictEqual(errorLog.callCount, 1, 'the ungated reporter still emitted exactly one record');
        assert.true(
          (errorLog.firstCall.args[0] as string).includes('execution failed unexpectedly'),
          'and it is the per-job batch failure record',
        );
      } finally {
        errorLog.restore();
        cronLog.restore();
        gate.restore();
      }
    });
  });
});
