/**
 * CronService — the main API for advanced job scheduling.
 *
 * Manages jobs in memory with a min-heap for efficient next-job lookup.
 * Supports pluggable store interface (memory-only by default, ORM in PR 2).
 * All state mutations are serialized via async locking.
 */
import config from 'stonyx/config';
import log from 'stonyx/log';
import MinHeap from './min-heap.js';
import { createJob, updateJob, markRunning, applyResult, isDue } from './job.js';
import { computeNextRunAtMs } from './schedule.js';
import { locked } from './locked.js';
import { normalizeJobInput, recoverFlatParams } from './normalize.js';
import RunLog from './run-log.js';

const MAX_TIMER_DELAY_MS = 60_000;

export default class CronService {
  constructor() {
    this.jobs = new Map();       // id → job
    this.heap = new MinHeap();   // ordered by nextRunAtMs
    this.timer = null;
    this.running = false;
    this.runLog = new RunLog();
    this.started = false;

    // Pluggable callbacks for consumers
    this.onJobDue = null;        // async (job) => { status, error?, summary? }
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Start the service. Loads jobs from store (if any), arms timer.
   */
  async start(initialJobs) {
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
  stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // ── CRUD ───────────────────────────────────────────────────

  /**
   * Get service status.
   */
  status() {
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
  list(opts) {
    const includeDisabled = opts?.includeDisabled ?? false;
    const jobs = [...this.jobs.values()];
    const filtered = includeDisabled ? jobs : jobs.filter(j => j.enabled);
    return filtered.sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
  }

  /**
   * Get a single job by ID.
   */
  get(id) {
    return this.jobs.get(id) || null;
  }

  /**
   * Add a new job. Input is normalized for AI compatibility.
   */
  async add(rawInput) {
    return locked(() => {
      const input = normalizeJobInput(recoverFlatParams(rawInput));
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
  async update(id, patch) {
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
  async remove(id) {
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
   * @param {string} id - Job ID
   * @param {"due"|"force"} [mode="force"] - "due" only runs if the job is due, "force" runs regardless
   */
  async run(id, mode = 'force') {
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
  runs(id, limit) {
    return this.runLog.get(id, limit);
  }

  // ── Timer Engine ──────────────────────────────────────��────

  armTimer() {
    clearTimeout(this.timer);
    if (!this.started) return;

    const peek = this.heap.peek();
    if (!peek) return;

    const delay = Math.min(Math.max(peek.nextTrigger - Date.now(), 0), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => this.onTimer(), delay);
  }

  async onTimer() {
    if (this.running) {
      // Already processing — re-arm at max delay to prevent scheduler death
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

  findDueJobs(nowMs) {
    const due = [];

    while (!this.heap.isEmpty()) {
      const peek = this.heap.peek();
      if (peek.nextTrigger > nowMs) break;

      this.heap.pop();
      const job = this.jobs.get(peek.key);
      if (job && isDue(job, nowMs)) {
        due.push(job);
      }
    }

    return due;
  }

  async executeJob(job) {
    const startMs = Date.now();
    let status = 'ok';
    let error;
    let summary;

    try {
      if (this.onJobDue) {
        const result = await this.onJobDue(job);
        if (result) {
          status = result.status || 'ok';
          error = result.error;
          summary = result.summary;
        }
      }
    } catch (err) {
      status = 'error';
      error = err?.message || String(err);
      this.log(`Job "${job.name}" (${job.id}) failed: ${error}`);
    }

    const durationMs = Date.now() - startMs;

    applyResult(job, status, error, durationMs);

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

  // ── Helpers ────────────────────────────────────────────────

  removeFromHeap(id) {
    // MinHeap doesn't support remove-by-key efficiently,
    // so we rebuild. Fine for typical job counts (< 1000).
    const remaining = [];
    while (!this.heap.isEmpty()) {
      const item = this.heap.pop();
      if (item.key !== id) remaining.push(item);
    }
    for (const item of remaining) {
      this.heap.push(item);
    }
  }

  log(message) {
    if (!config.cron?.log) return;
    log.cron(`Cron — ${message}`);
  }
}
