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
  reason?: string;
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
        await this.executeJob(job, true);
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
   * `alreadyClaimed` is passed by `onTimer`, which performs the batch claim
   * (findDueJobs + markRunning) for all due jobs under a single lock.
   */
  async executeJob(job: Job, alreadyClaimed = false): Promise<ExecuteResult> {
    // -- Phase 1: claim (locked) --
    if (!alreadyClaimed) {
      const claimed = await locked(() => this.claimJob(job));
      if (!claimed) return { status: 'skipped', reason: 'already running' };
    }

    // -- Phase 2: invoke (NOT locked) --
    const startMs = Date.now();
    let status: string = 'ok';
    let error: string | undefined;
    let summary: string | undefined;

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
      error = err instanceof Error ? err.message : String(err);
      this.log(`Job "${job.name}" (${job.id}) failed: ${error}`);
    }

    const durationMs = Date.now() - startMs;

    // -- Phase 3: settle (locked) --
    return locked(() => this.settleJob(job, status, error, summary, startMs, durationMs));
  }

  /**
   * Phase 1 - claim. Must be called while holding the lock.
   *
   * Returns false if the job is already running, so a second `run()` reports
   * "already running" instead of launching a concurrent invocation. Detaching
   * from the heap here (rather than relying on phase 3 to push a fresh entry)
   * is what keeps manual runs from permanently duplicating heap entries.
   */
  claimJob(job: Job): boolean {
    if (job.state.runningAtMs) return false;

    markRunning(job);
    this.removeFromHeap(job.id);

    return true;
  }

  /**
   * Phase 3 - settle. Must be called while holding the lock.
   */
  settleJob(
    job: Job,
    status: string,
    error: string | undefined,
    summary: string | undefined,
    startMs: number,
    durationMs: number,
  ): ExecuteResult {
    const validStatus = (status === 'ok' || status === 'error' || status === 'skipped') ? status : 'error';
    applyResult(job, validStatus, error, durationMs);

    // The callback ran unlocked, so it may have removed this job while it was
    // in flight. Do not resurrect a removed job's heap entry or run log.
    if (this.jobs.get(job.id) !== job) {
      this.removeFromHeap(job.id);
      this.armTimer();
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

    // Handle one-shot auto-delete
    if (job.deleteAfterRun && status === 'ok' && !job.enabled) {
      this.jobs.delete(job.id);
      this.removeFromHeap(job.id);
      this.runLog.removeJob(job.id);
      this.armTimer();
      return { status, summary, deleted: true };
    }

    // Re-insert into heap if still active. The callback ran unlocked, so it
    // may itself have added a heap entry for this job (via add/update); drop
    // any such entry first to preserve one-entry-per-key.
    this.removeFromHeap(job.id);
    if (job.enabled && job.state.nextRunAtMs) {
      this.heap.push({ key: job.id, nextTrigger: job.state.nextRunAtMs });
    }

    // The claim phase detached this job from the heap, so a timer that fired
    // during the unlocked invoke would have seen it missing. Re-arm here so a
    // manual run() can never leave the scheduler without a pending wake.
    this.armTimer();

    return { status, error, summary, durationMs };
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
