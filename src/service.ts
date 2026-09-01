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
      await locked(async () => {
        const nowMs = Date.now();
        const dueJobs = this.findDueJobs(nowMs);

        for (const job of dueJobs) {
          markRunning(job);
        }

        for (const job of dueJobs) {
          await this.executeJob(job);
        }
      });
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

  async executeJob(job: Job): Promise<ExecuteResult> {
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

    const validStatus = (status === 'ok' || status === 'error' || status === 'skipped') ? status : 'error';
    applyResult(job, validStatus, error, durationMs);

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
      this.runLog.removeJob(job.id);
      return { status, summary, deleted: true };
    }

    // Re-insert into heap if still active
    if (job.enabled && job.state.nextRunAtMs) {
      this.heap.push({ key: job.id, nextTrigger: job.state.nextRunAtMs });
    }

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
