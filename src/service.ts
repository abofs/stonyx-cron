/**
 * CronService - the main API for advanced job scheduling.
 *
 * Manages jobs in memory with a min-heap for efficient next-job lookup.
 *
 * Async locking, but never around the consumer callback. Execution is split
 * into three phases: claim (locked), invoke (UNLOCKED), settle (locked). Only
 * phases 1 and 3 are serialized; the critical section deliberately excludes
 * phase 2, so a consumer callback that never settles cannot wedge the lock
 * chain and block add/update/remove. See `run()` and `#executeClaimed`.
 *
 * CONSUMER NOTE — this class is NOMINALLY typed. It carries ECMAScript hard-
 * private members, so `dist/service.d.ts` emits `#private;` on the class and a
 * structurally-built test double will not assign to `CronService`
 * (`TS2741: Property '#private' is missing`). The break is one-directional and
 * has a zero-cost workaround: `extends CronService` still compiles, and
 * assigning a real `CronService` to your own hand-written interface still
 * compiles. Declare your own interface and depend on that rather than
 * hand-building a `CronService`-typed mock. See README's `CronService` section.
 */
import config from 'stonyx/config';
import log from 'stonyx/log';
import MinHeap, { type HeapItem } from './min-heap.js';
import { createJob, updateJob, markRunning, applyResult, isDue, type Job, type JobInput, type JobPatch } from './job.js';
import { computeNextRunAtMs } from './schedule.js';
import { locked } from './locked.js';
import { normalizeJobInput, recoverFlatParams } from './normalize.js';
import RunLog from './run-log.js';

const MAX_TIMER_DELAY_MS = 60_000;

/** Longest error text that may reach a log line. Anything past this is truncated. */
const MAX_LOGGED_ERROR_LENGTH = 512;

/** Longest job name that may reach a log line. Anything past this is truncated. */
const MAX_LOGGED_NAME_LENGTH = 120;

/**
 * Flatten a value for interpolation into a single log line.
 *
 * Chronicle writes `${timestamp} ${content}\n` to a newline-delimited file, so
 * any `\r` or `\n` inside `content` ends the record early and everything after
 * it is read back as a separate, attacker-shaped entry — including a forged
 * `[timestamp] Cron — ...` prefix that is indistinguishable from a real one.
 * Both values that reach these lines are untrusted: `job.name` is passed
 * through `createJob` unvalidated and `normalize.ts` exists specifically to
 * accept AI-shaped input, and an error message is arbitrary consumer-callback
 * text. Newlines become the literal two characters so the content survives for
 * a reader, and the length cap keeps one pathological value from swamping the
 * file.
 */
function forLog(value: string, maxLength: number): string {
  const flattened = value.replace(/\r\n|[\r\n\u2028\u2029]/g, '\\n');

  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}...` : flattened;
}

/**
 * Describe a thrown value without ever throwing.
 *
 * `String(err)` is not total: a null-prototype object, or any object whose
 * `toString`/`Symbol.toPrimitive` throws, raises "Cannot convert object to
 * primitive value". Consumer callbacks throw arbitrary values, so the error
 * handler must not become a second failure source of its own.
 *
 * The `instanceof Error` branch needs the same guard as the other one. `Error`
 * is subclassable and `message` is a plain writable property, so a consumer can
 * hand back an `Error` whose `message` is a getter that throws, or one that is
 * an object whose `toString` throws — `Error.prototype.message` is typed
 * `string`, so TypeScript sees nothing wrong and the coercion is deferred to
 * the caller's template literal, outside every guard here. That made `run()`
 * reject instead of returning an `ExecuteResult`: a contract violation in the
 * function written to prevent exactly that. Reading and coercing `message`
 * inside the `try` is what closes it.
 */
function describeError(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return 'unknown error';
  }
}

interface HeapEntry extends HeapItem {
  key: string;
}

/**
 * Why a `run()` did not invoke the callback. Exported so a consumer can write a
 * total handler over it: the union is closed and narrowed (it was `string`
 * before #34), so an exhaustive `switch` is now both possible and expected.
 */
export type SkipReason = 'not due' | 'already running' | 'removed';

/** What a claim refused on. `'not due'` is decided before the claim is attempted. */
type ClaimRefusal = Exclude<SkipReason, 'not due'>;

export interface JobDueResult {
  status?: string;
  error?: string;
  summary?: string;
}

export interface ExecuteResult {
  status: string;
  error?: string;
  summary?: string;
  durationMs?: number;
  deleted?: boolean;
  /** Only set when `status` is `'skipped'`. */
  reason?: SkipReason;
}

export interface ServiceStatus {
  started: boolean;
  jobCount: number;
  nextWakeAtMs: number | undefined;
}

export interface ListOptions {
  includeDisabled?: boolean;
}

export type OnJobDueCallback = (job: Job) => Promise<JobDueResult | void> | JobDueResult | void;

export default class CronService {
  jobs: Map<string, Job>;
  heap: MinHeap<HeapEntry>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  runLog: RunLog;
  started: boolean;

  // Pluggable callbacks for consumers
  onJobDue: OnJobDueCallback | null;

  constructor() {
    this.jobs = new Map();
    this.heap = new MinHeap();
    this.timer = null;
    this.running = false;
    this.runLog = new RunLog();
    this.started = false;
    this.onJobDue = null;
  }

  // -- Lifecycle -------------------------------------------------------

  /**
   * Start the service. Loads jobs from store (if any), arms timer.
   */
  async start(initialJobs?: Job[]): Promise<void> {
    if (this.started) return;
    this.started = true;

    // `finally`, not a trailing statement. Reconciled with the same guard #53
    // puts around `register`'s `runOnInit` invocation: a scheduler that is
    // marked started but never armed is the terminal state both fixes exist to
    // remove, reached here through the other entry point. `initialJobs` crosses
    // a serialization boundary — it is whatever the consumer's store handed
    // back — so `Job[]` is a compile-time claim about runtime data, and a row
    // missing `state` throws mid-loop. Without this, `start()` leaves
    // `started: true` (so it is now a no-op), the rows registered before the
    // throw sitting in the heap, and NO timer: measured, `status()` then
    // reports `{ started: true, jobCount: 1, nextWakeAtMs: <real> }` while
    // nothing will ever fire. Silent and healthy-looking, again.
    try {
      if (initialJobs) {
        for (const job of initialJobs) {
          // A `runningAtMs` on a rehydrated job is always stale. The claim it
          // records was taken by a process that is gone, so nothing will ever
          // settle it, and nothing reaps it — there is no lease on the field
          // (tracked on #35). Left in place it is a permanently dead job that
          // still reports healthy: `isDue` returns false forever because of the
          // flag, `run()` answers `'already running'` forever, `update()` never
          // touches `state.runningAtMs`, and `status()` counts it like any other.
          // The consumer's only recovery would be remove() + add(), losing the
          // job id and its run history.
          //
          // Same hazard, same treatment as the hand-release on the `'removed'`
          // path in `#executeClaimed`: a claim with no reachable settle must be
          // released. Assigned directly rather than via `applyResult` for the same
          // reason — this releases the claim and nothing else. The job did not
          // run, so it gets no run-log row, no `lastStatus`, and no recomputed
          // `nextRunAtMs`; it is rescheduled from the store's own value below.
          //
          // Written unconditionally, and deliberately NOT guarded on a
          // `job.state.runningAtMs` read. Guarding it makes `start()` accept a
          // row whose `state` is frozen — `structuredClone` + `Object.freeze`
          // is an ordinary defensive rehydration — and that row is not usable
          // by this class at all: `markRunning` writes the same field on every
          // execution. Measured, the guard moves the failure from a throw out
          // of `start()`, which the consumer's own `await` can catch, to a
          // TypeError raised inside `onTimer`'s batch claim — a bare timer
          // callback, so it surfaces as an unhandled rejection and is
          // process-fatal under Node's default. Failing loudly at the store
          // boundary is the better of the two, and the `finally` above keeps
          // the rows that loaded before it scheduled.
          job.state.runningAtMs = undefined;

          this.jobs.set(job.id, job);
          if (job.enabled && job.state.nextRunAtMs) {
            this.heap.push({ key: job.id, nextTrigger: job.state.nextRunAtMs });
          }
        }
      }
    } finally {
      this.armTimer();
    }
  }

  /**
   * Stop the service. Clears timer.
   */
  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // -- CRUD ------------------------------------------------------------

  /**
   * Get service status.
   */
  status(): ServiceStatus {
    const peek = this.heap.peek();
    return {
      started: this.started,
      jobCount: this.jobs.size,
      nextWakeAtMs: peek ? peek.nextTrigger : undefined,
    };
  }

  /**
   * List jobs, optionally including disabled ones.
   */
  list(opts?: ListOptions): Job[] {
    const includeDisabled = opts?.includeDisabled ?? false;
    const jobs = [...this.jobs.values()];
    const filtered = includeDisabled ? jobs : jobs.filter(j => j.enabled);
    return filtered.sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
  }

  /**
   * Get a single job by ID.
   */
  get(id: string): Job | null {
    return this.jobs.get(id) || null;
  }

  /**
   * Add a new job. Input is normalized for AI compatibility.
   */
  async add(rawInput: Record<string, unknown>): Promise<Job> {
    return locked(() => {
      const input = normalizeJobInput(recoverFlatParams(rawInput as Record<string, unknown>)) as unknown as JobInput;
      const job = createJob(input);
      this.jobs.set(job.id, job);

      if (job.enabled && job.state.nextRunAtMs) {
        this.heap.push({ key: job.id, nextTrigger: job.state.nextRunAtMs });
        this.armTimer();
      }

      return job;
    });
  }

  /**
   * Update an existing job.
   */
  async update(id: string, patch: JobPatch): Promise<Job> {
    return locked(() => {
      const job = this.jobs.get(id);
      if (!job) throw new Error(`Job not found: ${id}`);

      const oldNextRun = job.state.nextRunAtMs;
      updateJob(job, patch);

      // Update heap entry
      this.removeFromHeap(id);
      if (job.enabled && job.state.nextRunAtMs) {
        this.heap.push({ key: id, nextTrigger: job.state.nextRunAtMs });
      }

      if (job.state.nextRunAtMs !== oldNextRun) {
        this.armTimer();
      }

      return job;
    });
  }

  /**
   * Remove a job.
   */
  async remove(id: string): Promise<void> {
    return locked(() => {
      const job = this.jobs.get(id);
      if (!job) throw new Error(`Job not found: ${id}`);

      this.jobs.delete(id);
      this.removeFromHeap(id);
      this.runLog.removeJob(id);
      this.armTimer();
    });
  }

  /**
   * Manually trigger a job.
   *
   * Returns `{ status: 'skipped', reason }` without invoking the callback when
   * the job is not due (`mode: 'due'`), is already in flight
   * (`'already running'`), or was removed before the claim landed
   * (`'removed'`). Before the phase split, a forced run against an in-flight
   * job launched a second concurrent invocation.
   *
   * THROWS (rather than returning a skip) when `id` is not a registered job:
   * `Error("Job not found: <id>")`. A job that disappears between this lookup
   * and the claim is the `'removed'` skip above, not a throw — the two differ
   * only by the timing of a race, and the second is a legitimate outcome
   * whereas the first is a caller error.
   *
   * CONCURRENCY: the same job is bounded to one in-flight invocation on every
   * path, and the timer path invokes due jobs one at a time. `run()` fan-out
   * across DIFFERENT jobs is deliberately unbounded — N concurrent `run()`
   * calls produce N concurrent consumer callbacks. Before the phase split
   * these serialized behind the module-global lock; that serialization was the
   * bug rather than the feature (one hung callback wedged every other caller),
   * so it is not restored here. The fan-out is caller-driven and the scheduler
   * never produces it on its own. A per-invoke bound belongs above this layer;
   * it is tracked on stonyx-cron#35 alongside the execution timeout.
   *
   * NOT FIXED HERE: the phase split fixes the LOCK wedge, not the TIMER. A
   * callback that never settles still stops `onTimer`'s sequential loop
   * forever — `running` stays true, every later tick early-returns and re-arms,
   * and the hung job's batch siblings stay claimed and off-heap having never
   * been invoked. CRUD still resolves and `status()` still reports
   * `started: true`, so that failure is now silent where it used to be loud.
   * Bounding the callback and releasing batch siblings is stonyx-cron#35. Do
   * not read this method's doc as "the hang is fixed".
   */
  async run(id: string, mode: 'due' | 'force' = 'force'): Promise<ExecuteResult> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);

    if (mode === 'due' && !isDue(job, Date.now())) {
      return { status: 'skipped', reason: 'not due' };
    }

    // Deliberately NOT wrapped in locked(): executeJob takes the lock itself,
    // for its claim and settle phases only. Wrapping here would re-create the
    // wedge through a second door, because the consumer callback would once
    // again be awaited while a lock is held.
    return this.executeJob(job);
  }

  /**
   * Get run history for a job.
   */
  runs(id: string, limit?: number): ReturnType<RunLog['get']> {
    return this.runLog.get(id, limit);
  }

  // -- Timer Engine ----------------------------------------------------

  armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.started) return;

    const peek = this.heap.peek();
    if (!peek) return;

    const delay = Math.min(Math.max(peek.nextTrigger - Date.now(), 0), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => this.onTimer(), delay);
  }

  async onTimer(): Promise<void> {
    if (this.running) {
      // Already processing - re-arm at max delay to prevent scheduler death
      this.timer = setTimeout(() => this.onTimer(), MAX_TIMER_DELAY_MS);
      return;
    }

    this.running = true;

    try {
      // -- Phase 1: claim (locked), batched --
      // Collecting due jobs pops them off the heap, and marking them running
      // makes them un-claimable by anyone else. Both must happen under the
      // same lock turn, or a concurrent run() could claim a job this batch has
      // already detached.
      //
      // This is the SECOND claim implementation — `#claimJob` is the other, and
      // the two reach the same state by different routes. `#claimJob` guards
      // with an explicit `job.state.runningAtMs` check; this path has no such
      // check and relies entirely on `isDue`'s `!job.state.runningAtMs` clause
      // (`job.ts`) to keep `findDueJobs` from re-claiming a job that `run()`
      // already holds. THAT CLAUSE IS LOAD-BEARING HERE, not an optimisation:
      // drop it and the timer path silently double-invokes a job that `run()`
      // is mid-flight on, while `run()` keeps refusing correctly and looks
      // healthy. The one-in-flight-invocation-per-job invariant this class
      // advertises holds by two independent guards in two files; a change to
      // either has to be checked against the other.
      const dueJobs = await locked(() => {
        const nowMs = Date.now();
        const due = this.findDueJobs(nowMs);

        for (const job of due) {
          markRunning(job);
        }

        return due;
      });

      // Phases 2 and 3 run OUTSIDE the claim lock. The consumer callback is
      // awaited here holding no lock at all, so a callback that never settles
      // cannot poison the lock chain and wedge add/update/remove.
      for (const job of dueJobs) {
        try {
          await this.#executeClaimed(job);
        } catch (err: unknown) {
          // One job's unexpected throw must not abort the batch. Every job in
          // `dueJobs` is already claimed — marked running and detached from
          // the heap — and only its own settle releases it, so aborting here
          // would strand every sibling permanently un-due.
          //
          // Reported on an UNGATED channel. `this.log()` returns early when
          // `config.cron.log` is false, which is a supported production
          // setting, and a failure here permanently unschedules a job while
          // `status()` keeps reporting the service healthy. Silent-and-healthy
          // is exactly the failure class this split exists to remove.
          //
          // This is the outermost handler on the timer path, so it is the one
          // that must not be able to throw: `log` is a shared singleton whose
          // transports can reach the filesystem, so its own failure is
          // swallowed rather than allowed to take the batch down.
          //
          // BOTH halves of that failure have to be caught, and they are caught
          // by different constructs. `log.error` is a chronicle convenience
          // method that returns `logAction(...)` -> `async log(...)`, so its
          // console write, colour lookup, `mkdirSync` and `appendFile` all
          // surface as REJECTIONS, never as synchronous throws. A bare call
          // here escapes this `catch` entirely and terminates the process under
          // Node's default `--unhandled-rejections=throw` — the handler written
          // so it "must not be able to throw" would be the one taking the
          // daemon down. The `try` covers the synchronous half (evaluating the
          // template literal); `Promise.resolve(...).catch()` covers the async
          // half. Deliberately not awaited: the batch must not block on a log
          // transport, and `void` marks the floated promise as intentional.
          try {
            void Promise.resolve(
              log.error(`Cron — Job "${forLog(job.name, MAX_LOGGED_NAME_LENGTH)}" (${job.id}) execution failed unexpectedly: ${forLog(describeError(err), MAX_LOGGED_ERROR_LENGTH)}`),
            ).catch(() => {
              // Nothing left to report to.
            });
          } catch {
            // Nothing left to report to.
          }
        }
      }
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  findDueJobs(nowMs: number): Job[] {
    const due: Job[] = [];

    while (!this.heap.isEmpty()) {
      const peek = this.heap.peek();
      if (!peek || peek.nextTrigger > nowMs) break;

      this.heap.pop();
      const job = this.jobs.get(peek.key);
      if (job && isDue(job, nowMs)) {
        due.push(job);
      }
    }

    return due;
  }

  /**
   * Execute a job in three phases:
   *
   *   1. claim  (locked)   — take ownership of the job, detach it from the heap
   *   2. invoke (UNLOCKED) — await the consumer callback
   *   3. settle (locked)   — apply the result, log it, re-insert into the heap
   *
   * The critical section deliberately excludes phase 2. `onJobDue` is
   * arbitrary, unbounded consumer code; awaiting it under the module-global
   * lock is what wedged every subsequent `locked()` call (add/update/remove)
   * when a callback never settled.
   *
   * `onTimer` performs the batch claim (`findDueJobs` + `markRunning`) for all
   * due jobs under a single lock and then enters at phase 2 via
   * `#executeClaimed`. That entry point is `#private` rather than a parameter
   * on this method: as a published `alreadyClaimed` flag it would be a
   * supported way to skip phase 1 entirely, defeating the claim guard and
   * allowing concurrent `onJobDue` invocations for the same job.
   */
  async executeJob(job: Job): Promise<ExecuteResult> {
    // -- Phase 1: claim (locked) --
    const refusal = await locked(() => this.#claimJob(job));
    if (refusal) return { status: 'skipped', reason: refusal };

    return this.#executeClaimed(job);
  }

  /**
   * Phases 2 and 3 for a job that has already been claimed — either by
   * `executeJob` above or by `onTimer`'s batch claim.
   *
   * Private: reaching this without a claim would run the consumer callback for
   * a job nobody owns, and would leave nothing to release the claim.
   */
  async #executeClaimed(job: Job): Promise<ExecuteResult> {
    // Membership re-check. The claim and the invoke are no longer in the same
    // critical section, and sibling callbacks run unlocked, so a `remove()` can
    // now land in between AND RESOLVE — it used to deadlock. A resolved
    // `remove()` must keep meaning "this callback will not fire"; the identity
    // guard in `#settleJob` only cleans up afterwards, by which point the side
    // effect has already happened. Identity, not id, so a removed-then-replaced
    // key is caught too. Deliberately synchronous with the `onJobDue` call
    // below — nothing can interleave between this check and the invocation.
    //
    // This is the one early return after a claim, so it is the one that has to
    // release the claim by hand. Skipping settle is right — re-inserting or
    // run-logging a removed job is the resurrection `#settleJob` refuses, and
    // the heap entry is already gone. But the claim must still come off,
    // because the detached object is NOT unreachable: it is the object `add()`
    // returned and `get()`/`list()` hand out, and `start(initialJobs)`
    // re-registers those objects verbatim, `state` included. A leftover
    // `runningAtMs` rehydrates a permanently dead job — `isDue` false forever,
    // `run()` refused forever, `status()` reporting it healthy.
    //
    // Assigned directly rather than via `applyResult`: this releases the claim
    // and nothing else. No run-log row, no heap entry, no `lastStatus`, no
    // recomputed `nextRunAtMs` — the job did not run.
    if (this.jobs.get(job.id) !== job) {
      job.state.runningAtMs = undefined;
      return { status: 'skipped', reason: 'removed' };
    }

    const startMs = Date.now();
    let status: string = 'ok';
    let error: string | undefined;
    let summary: string | undefined;
    let settled: ExecuteResult;

    // The claim marked the job running and detached it from the heap. Phase 3
    // is the ONLY thing that undoes either, so it must survive every non-local
    // exit from phase 2 — including a throw from the catch handler itself
    // (`this.log` is public and overridable and reaches a transport). A claim
    // with no matching settle is not a degraded state, it is a permanently
    // dead job.
    try {
      // -- Phase 2: invoke (NOT locked) --
      try {
        if (this.onJobDue) {
          const result = await this.onJobDue(job);
          if (result) {
            status = result.status || 'ok';
            error = result.error;
            summary = result.summary;
          }
        }
      } catch (err: unknown) {
        status = 'error';
        error = describeError(err);
        this.log(`Job "${forLog(job.name, MAX_LOGGED_NAME_LENGTH)}" (${job.id}) failed: ${forLog(error, MAX_LOGGED_ERROR_LENGTH)}`);
      }
    } finally {
      // -- Phase 3: settle (locked) --
      settled = await locked(() => this.#settleJob(job, status, error, summary, startMs, Date.now() - startMs));
    }

    return settled;
  }

  /**
   * Phase 1 — claim. Must be called while holding the lock (`locked()`, whose
   * chain is module-global and therefore shared across CronService instances).
   *
   * Returns `null` on a successful claim, or the reason the claim was refused.
   * `'already running'` is what makes a second `run()` report a skip instead of
   * launching a concurrent invocation. `'removed'` covers the job being deleted
   * between `run()`'s unlocked lookup and this lock turn — claiming then would
   * `markRunning` an orphan and, worse, `removeFromHeap` an id that may now
   * belong to a replacement.
   *
   * Detaching from the heap here — rather than relying on phase 3 to push a
   * fresh entry — is what stops manual runs permanently duplicating entries.
   *
   * `#private`: published, this would be a supported call performing
   * `markRunning` + `removeFromHeap` with no guaranteed settle and no lease on
   * `runningAtMs`, so a single such call would strand the job forever. The
   * lock-held precondition cannot be expressed in the type system, so the
   * method must not be reachable from outside the class body.
   */
  #claimJob(job: Job): ClaimRefusal | null {
    if (this.jobs.get(job.id) !== job) return 'removed';
    if (job.state.runningAtMs) return 'already running';

    markRunning(job);
    this.removeFromHeap(job.id);

    return null;
  }

  /**
   * Phase 3 — settle. Must be called while holding the lock.
   *
   * `#private` for the same reason as `#claimJob`: unlocked it would run
   * `applyResult`, a `runLog.record`, a full `removeFromHeap` rebuild, a
   * `heap.push` and an `armTimer` with no mutual exclusion — exactly the
   * corruption `locked()` exists to prevent.
   */
  #settleJob(
    job: Job,
    status: string,
    error: string | undefined,
    summary: string | undefined,
    startMs: number,
    durationMs: number,
  ): ExecuteResult {
    try {
      const validStatus = (status === 'ok' || status === 'error' || status === 'skipped') ? status : 'error';
      applyResult(job, validStatus, error, durationMs);

      // The callback ran unlocked, so this job may have been removed — or
      // removed and re-registered under the same id, the shape
      // `start(initialJobs)` uses — while it was in flight. Identity, not id.
      //
      // Deliberately touch NOTHING here. The claim already detached this job's
      // heap entry and nothing re-added it, so there is nothing to clean up;
      // any entry now filed under this id belongs to the replacement, and
      // removing it by id would silently unschedule a live job. Do not
      // resurrect a removed job's heap entry or run log either.
      if (this.jobs.get(job.id) !== job) {
        return { status, error, summary, durationMs };
      }

      // Log the run
      this.runLog.record({
        jobId: job.id,
        status,
        error,
        summary,
        runAtMs: startMs,
        durationMs,
        nextRunAtMs: job.state.nextRunAtMs,
      });

      // Handle one-shot auto-delete. The callback ran unlocked and may have
      // pushed a heap entry for this job via add()/update(), so drop it — the
      // job is about to stop existing.
      if (job.deleteAfterRun && status === 'ok' && !job.enabled) {
        this.jobs.delete(job.id);
        this.removeFromHeap(job.id);
        this.runLog.removeJob(job.id);
        return { status, summary, deleted: true };
      }

      // Re-insert into the heap if still active. Same reason as above: drop any
      // entry the unlocked callback added for this job first, to preserve
      // one-entry-per-key.
      this.removeFromHeap(job.id);
      if (job.enabled && job.state.nextRunAtMs) {
        this.heap.push({ key: job.id, nextTrigger: job.state.nextRunAtMs });
      }

      return { status, error, summary, durationMs };
    } finally {
      // One re-arm covering every exit, rather than one per branch. The claim
      // detached this job from the heap, so a timer that fired during the
      // unlocked invoke would have found nothing to arm — and `run()` has no
      // `finally { armTimer() }` of its own the way `onTimer` does. Without
      // this, a manual run() can leave the scheduler with no pending wake.
      this.armTimer();
    }
  }

  // -- Helpers ---------------------------------------------------------

  removeFromHeap(id: string): void {
    // MinHeap doesn't support remove-by-key efficiently,
    // so we rebuild. Fine for typical job counts (< 1000).
    const remaining: HeapEntry[] = [];
    while (!this.heap.isEmpty()) {
      const item = this.heap.pop();
      if (!item) break;
      if (item.key !== id) remaining.push(item);
    }
    for (const item of remaining) {
      this.heap.push(item);
    }
  }

  log(message: string): void {
    if (!config.cron?.log) return;
    log.cron(`Cron — ${message}`);
  }
}
