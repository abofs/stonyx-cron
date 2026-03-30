/**
 * In-memory run log for job execution history.
 * Stores recent execution results per job with auto-pruning.
 *
 * Persistence (via ORM) is added in PR 2.
 */

const DEFAULT_MAX_ENTRIES_PER_JOB = 100;

export default class RunLog {
  constructor(maxEntriesPerJob = DEFAULT_MAX_ENTRIES_PER_JOB) {
    this.maxEntries = maxEntriesPerJob;
    this.entries = new Map(); // jobId → RunLogEntry[]
  }

  /**
   * Record a job execution result.
   *
   * @param {object} entry
   * @param {string} entry.jobId
   * @param {"ok"|"error"|"skipped"} entry.status
   * @param {string} [entry.error]
   * @param {string} [entry.summary]
   * @param {number} [entry.runAtMs]
   * @param {number} [entry.durationMs]
   * @param {number} [entry.nextRunAtMs]
   */
  record(entry) {
    const log = {
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

    const logs = this.entries.get(entry.jobId);
    logs.push(log);

    // Auto-prune
    if (logs.length > this.maxEntries) {
      logs.splice(0, logs.length - this.maxEntries);
    }
  }

  /**
   * Get run history for a job.
   *
   * @param {string} jobId
   * @param {number} [limit=20]
   * @returns {object[]} Most recent entries, newest first
   */
  get(jobId, limit = 20) {
    const logs = this.entries.get(jobId);
    if (!logs) return [];
    return logs.slice(-limit).reverse();
  }

  /**
   * Remove all entries for a job.
   */
  removeJob(jobId) {
    this.entries.delete(jobId);
  }

  /**
   * Clear all entries.
   */
  clear() {
    this.entries.clear();
  }
}
