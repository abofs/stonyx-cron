/**
 * In-memory run log for job execution history.
 * Stores recent execution results per job with auto-pruning.
 */

const DEFAULT_MAX_ENTRIES_PER_JOB = 100;

export interface RunLogEntry {
  ts: number;
  jobId: string;
  status: string;
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
}

export interface RunLogInput {
  jobId: string;
  status: string;
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
}

export default class RunLog {
  maxEntries: number;
  entries: Map<string, RunLogEntry[]>;

  constructor(maxEntriesPerJob: number = DEFAULT_MAX_ENTRIES_PER_JOB) {
    this.maxEntries = maxEntriesPerJob;
    this.entries = new Map();
  }

  /**
   * Record a job execution result.
   */
  record(entry: RunLogInput): void {
    const log: RunLogEntry = {
      ts: Date.now(),
      jobId: entry.jobId,
      status: entry.status,
      error: entry.error,
      summary: entry.summary,
      runAtMs: entry.runAtMs,
      durationMs: entry.durationMs,
      nextRunAtMs: entry.nextRunAtMs,
    };

    if (!this.entries.has(entry.jobId)) {
      this.entries.set(entry.jobId, []);
    }

    const logs = this.entries.get(entry.jobId)!;
    logs.push(log);

    // Auto-prune
    if (logs.length > this.maxEntries) {
      logs.splice(0, logs.length - this.maxEntries);
    }
  }

  /**
   * Get run history for a job.
   */
  get(jobId: string, limit: number = 20): RunLogEntry[] {
    const logs = this.entries.get(jobId);
    if (!logs) return [];
    return logs.slice(-limit).reverse();
  }

  /**
   * Remove all entries for a job.
   */
  removeJob(jobId: string): void {
    this.entries.delete(jobId);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
  }
}
