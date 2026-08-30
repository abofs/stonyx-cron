/**
 * CronService - the main API for advanced job scheduling.
 *
 * Manages jobs in memory with a min-heap for efficient next-job lookup.
 * All state mutations are serialized via async locking.
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

/**
 * Describe a thrown value without ever throwing.
 *
 * `String(err)` is not total: a null-prototype object, or any object whose
 * `toString`/`Symbol.toPrimitive` throws, raises "Cannot convert object to
 * primitive value". Consumer callbacks throw arbitrary values, so the error
 * handler itself must not be a second failure source.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;

  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

interface HeapEntry extends HeapItem {
  key: string;
}

interface JobDueResult {
  status?: string;
  error?: string;
  summary?: string;
}

interface ExecuteResult {
  status: string;
  error?: string;
  summary?: string;
  durationMs?: number;
  deleted?: boolean;
  /** Only set when `status` is `'skipped'`. */
  reason?: 'not due' | 'already running' | 'removed';
}

interface ServiceStatus {
  started: boolean;
  jobCount: number;
  nextWakeAtMs: number | undefined;
}

interface ListOptions {
  includeDisabled?: boolean;
}

type OnJobDueCallback = (job: Job) => Promise<JobDueResult | void> | JobDueResult | void;

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

    if (initialJobs) {
      for (const job of initialJobs) {
        this.jobs.set(job.id, job);
        if (job.enabled && job.state.nextRunAtMs) {
          this.heap.push({ key: job.id, nextTrigger: job.state.nextRunAtMs });
        }
      }
    }

    this.armTimer();
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
   * (`'removed'`). Before the phase split a forced run against an in-flight job
   * launched a second concurrent invocation; refusing it is AC4 of #34.
   *
   * CONCURRENCY: the same job is bounded to one in-flight invocation on every
   * path, and the timer path invokes due jobs one at a time. `run()` fan-out
   * across DIFFERENT jobs is deliberately unbounded - N concurrent `run()`
   * calls produce N concurrent consumer callbacks. Before the phase split
   * these serialized behind the module-global lock; that serialization was the
   * bug, not the feature (one hung callback wedged every other caller), so it
   * is not being restored here. The fan-out is caller-driven: it is bounded by
   * how many times the consumer chooses to call `run()`, exactly like any other
   * async API, and the scheduler never produces it on its own. A consumer that
   * exposes `run()` over HTTP or a CLI owns that bound the same way it owns
   * request concurrency for every other handler. A per-invoke bound inside the
   * service is tracked separately (#35).
   */
  async run(id: string, mode: 'due' | 'force' = 'force'): Promise<ExecuteResult> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);

    if (mode === 'due' && !isDue(job, Date.now())) {
      return { status: 'skipped', reason: 'not due' };
    }

    // Deliberately NOT wrapped in locked(): executeJob takes the lock itself
    // for its claim and settle phases only. Wrapping here would re-create the
    // wedge through a second door, since the callback would again be awaited
    // while a lock is held.
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
      // Phase 1 - claim (locked). Collecting due jobs pops them off the heap
      // and marking them running makes them un-collectable by anyone else, so
      // both must happen under the same lock.
      const dueJobs = await locked(() => {
        const nowMs = Date.now();
        const due = this.findDueJobs(nowMs);

        for (const job of due) {
          markRunning(job);
        }

        return due;
      });

      // Phases 2 and 3 run outside the claim lock. The consumer callback is
      // awaited here holding no lock at all, so a callback that never settles
      // cannot poison the lock chain.
      for (const job of dueJobs) {
        try {
          await this.#executeClaimed(job);
        } catch (err: unknown) {
          // One job's unexpected throw must not abort the batch. Every job in
          // `dueJobs` is already claimed - marked running and detached from the
          // heap - and only its own settle releases it, so aborting here would
          // strand every sibling permanently un-due.
          //
          // Reported on an UNGATED channel. `this.log()` returns early when
          // `config.cron.log` is false - a supported production setting - and a
          // failure here permanently unschedules the job while `status()` keeps
          // reporting the service healthy. Silent-and-healthy is the failure
          // class the phase split exists to remove, so the one handler that
          // survives it must not depend on a log flag. `log.error` is a Stonyx
          // system log type, created in the Log constructor rather than by
          // `defineType`, so it is always callable and never gated.
          //
          // This is the outermost handler on the timer path, so it is the one
          // that must not be able to throw. `log` is a shared singleton whose
          // transports can reach the filesystem, so its own failure is
          // swallowed here rather than being allowed to take the batch down.
          try {
            log.error(`Cron — Job "${job.name}" (${job.id}) execution failed unexpectedly: ${describeError(err)}`);
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
   *   1. claim  (locked)   - take ownership of the job, detach it from the heap
   *   2. invoke (UNLOCKED) - await the consumer callback
   *   3. settle (locked)   - apply the result, log it, re-insert into the heap
   *
   * The critical section deliberately excludes phase 2. `onJobDue` is
   * arbitrary, unbounded consumer code; awaiting it under the module-global
   * lock is what wedged every subsequent `locked()` call (add/update/remove)
   * when a callback never settled.
   *
   * `onTimer` performs the batch claim (findDueJobs + markRunning) for all due
   * jobs under a single lock, then enters at phase 2 via `#executeClaimed`.
   * That entry point is a `#private` method rather than a parameter on this
   * one: as a published `alreadyClaimed` boolean it was a supported way for a
   * consumer to skip phase 1 entirely, which defeats the claim guard AC4 asks
   * for and allows concurrent `onJobDue` invocations for the same job.
   */
  async executeJob(job: Job): Promise<ExecuteResult> {
    // -- Phase 1: claim (locked) --
    const refusal = await locked(() => this.#claimJob(job));
    if (refusal) return { status: 'skipped', reason: refusal };

    return this.#executeClaimed(job);
  }

  /**
   * Phases 2 and 3 for a job that has already been claimed - either by
   * `executeJob` above or by `onTimer`'s batch claim.
   *
   * Private: reaching this without a claim would run the consumer callback for
   * a job nobody owns.
   */
  async #executeClaimed(job: Job): Promise<ExecuteResult> {
    // Membership re-check. The claim and the invoke are no longer in the same
    // critical section, and sibling callbacks run unlocked, so a `remove()` can
    // land in between AND RESOLVE - it used to deadlock. A resolved `remove()`
    // must keep meaning "this callback will not fire": #settleJob's identity
    // guard only cleans up afterwards, by which point the side effect has
    // already happened. Identity, not id, so a removed-then-replaced key is
    // caught too. Deliberately synchronous with the `onJobDue` call below -
    // nothing can interleave between this check and the invocation.
    //
    // This is the ONE early return in the phase-2/3 control flow that happens
    // after a claim, so it is the one that has to release the claim by hand.
    // (`executeJob`'s refusal return at the call site is pre-claim; `onTimer`'s
    // re-entrancy return never claims; every return inside `#settleJob` is
    // already past phase 3.)
    //
    // Skipping settle entirely here is right - re-inserting or run-logging a
    // removed job is exactly the resurrection `#settleJob`'s identity guard
    // refuses, and its heap entry is already gone. But the claim itself must
    // still come off, because the detached object is NOT unreachable: it is the
    // object `add()` returned and `get()`/`list()` hand out, and
    // `start(initialJobs)` re-registers those objects verbatim, `state`
    // included. Leaving `runningAtMs` set means a consumer that persists jobs
    // rehydrates a permanently dead one - `isDue` false forever, `run()`
    // refused forever, `status()` reporting it healthy. That is the
    // claim-without-settle hazard the try/finally below exists for, reached
    // through a different door.
    //
    // Assigned directly rather than via `applyResult`: this must release the
    // claim and nothing else. No run-log row, no heap entry, no lastStatus, no
    // recomputed nextRunAtMs - the job did not run.
    if (this.jobs.get(job.id) !== job) {
      job.state.runningAtMs = undefined;
      return { status: 'skipped', reason: 'removed' };
    }

    const startMs = Date.now();
    let status: string = 'ok';
    let error: string | undefined;
    let summary: string | undefined;
    let settled: ExecuteResult | undefined;

    // The claim above marked the job running and detached it from the heap.
    // Phase 3 is the ONLY thing that undoes either, so it must survive every
    // non-local exit from phase 2 - including a throw from the catch handler
    // itself. A claim with no matching settle is not a degraded state, it is a
    // permanently dead job: `runningAtMs` set, no heap entry, `isDue` false
    // forever and `run()` refused forever.
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
        this.log(`Job "${job.name}" (${job.id}) failed: ${error}`);
      }
    } finally {
      // -- Phase 3: settle (locked) --
      settled = await locked(() => this.#settleJob(job, status, error, summary, startMs, Date.now() - startMs));
    }

    return settled;
  }

  /**
   * Phase 1 - claim. Must be called while holding the lock (`locked()`, whose
   * chain is module-global and therefore shared across CronService instances).
   *
   * `#private`, like `#executeClaimed` and for the same reason. Published, this
   * was a supported call performing `markRunning` + `removeFromHeap` with no
   * guaranteed settle - the claim-without-settle shape the try/finally in
   * `#executeClaimed` exists to prevent, and with no lease on `runningAtMs` a
   * single such call permanently strands the job: off the heap, marked running,
   * with nothing that will ever release it. The precondition below cannot be
   * expressed in the type system, so the method must not be reachable from
   * outside the class body.
   *
   * Returns `null` on a successful claim, or the reason the claim was refused.
   * "already running" is what makes a second `run()` report a skip instead of
   * launching a concurrent invocation. "removed" covers the job being deleted
   * between `run()`'s unlocked lookup and this lock turn - claiming then would
   * `markRunning` an orphan and, worse, `removeFromHeap` an id that may now
   * belong to a replacement.
   *
   * Detaching from the heap here (rather than relying on phase 3 to push a
   * fresh entry) is what keeps manual runs from permanently duplicating heap
   * entries.
   */
  #claimJob(job: Job): 'already running' | 'removed' | null {
    if (this.jobs.get(job.id) !== job) return 'removed';
    if (job.state.runningAtMs) return 'already running';

    markRunning(job);
    this.removeFromHeap(job.id);

    return null;
  }

  /**
   * Phase 3 - settle. Must be called while holding the lock.
   *
   * `#private` for the same reason as `#claimJob`: unlocked it would run
   * `applyResult`, a `runLog.record`, a full `removeFromHeap` rebuild, a
   * `heap.push` and an `armTimer` with no mutual exclusion - exactly the
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

      // The callback ran unlocked, so this job may have been removed - or
      // removed and re-registered under the same id (the shape
      // `start(initialJobs)` uses) - while it was in flight. Identity, not id.
      //
      // Deliberately touch NOTHING here. The claim phase already detached this
      // job's own heap entry and nothing re-added it, so there is nothing to
      // clean up; any entry now filed under this id belongs to the
      // replacement, and removing it by id would silently unschedule a live
      // job. Do not resurrect a removed job's heap entry or run log either.
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
      // pushed a heap entry for this job via update(), so drop it - the job is
      // about to stop existing.
      if (job.deleteAfterRun && status === 'ok' && !job.enabled) {
        this.jobs.delete(job.id);
        this.removeFromHeap(job.id);
        this.runLog.removeJob(job.id);
        return { status, summary, deleted: true };
      }

      // Re-insert into heap if still active. The callback ran unlocked, so it
      // may itself have added a heap entry for this job (via add/update); drop
      // any such entry first to preserve one-entry-per-key.
      this.removeFromHeap(job.id);
      if (job.enabled && job.state.nextRunAtMs) {
        this.heap.push({ key: job.id, nextTrigger: job.state.nextRunAtMs });
      }

      return { status, error, summary, durationMs };
    } finally {
      // One re-arm covering every exit, rather than one per branch. The claim
      // phase detached this job from the heap, so a timer that fired during the
      // unlocked invoke would have found an empty heap and armed nothing -
      // and `run()` has no `finally { armTimer() }` of its own the way
      // `onTimer` does. Without this a manual run() can leave the scheduler
      // with no pending wake at all.
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

    // `log.cron` is created by `log.defineType`, which runs in `Cron.init()`
    // (src/main.ts) - a DIFFERENT class. A consumer wiring CronService directly
    // never runs it, while `config/environment.js` defaults `cron.log` to true,
    // so an unguarded call throws `log.cron is not a function`. That throw
    // escapes executeJob's catch, and the error-reporting path must never be
    // the thing that kills the scheduler. `src/types/stonyx.d.ts:19` declares
    // `cron()` unconditionally, so the type system will not catch this.
    const { logColor = '#888', logMethod = 'cron' } = config.cron ?? {};
    if (typeof log[logMethod] !== 'function') log.defineType(logMethod, logColor);

    const method = log[logMethod];
    if (typeof method !== 'function') return;

    (method as (content: string) => void).call(log, `Cron — ${message}`);
  }
}
