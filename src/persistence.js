/**
 * ORM persistence adapter for CronService.
 *
 * Bridges the in-memory job model (src/job.js) with @stonyx/orm records.
 * Only loaded when persistence is configured — ORM is an optional dependency.
 */

let orm, store, createRecord, updateRecord;

/**
 * Initialize the persistence layer by importing ORM.
 * Must be called after ORM module is ready (via waitForModule).
 */
export async function initPersistence() {
  const ormModule = await import('@stonyx/orm');
  orm = ormModule.default;
  store = ormModule.store;
  createRecord = ormModule.createRecord;
  updateRecord = ormModule.updateRecord;
}

/**
 * Convert an in-memory job object to ORM-compatible flat data.
 */
function jobToRecord(job) {
  return {
    id: job.id,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
    schedule: { id: job.id, ...job.schedule },
    payload: { id: job.id, ...job.payload },
    state: { id: job.id, ...job.state },
    delivery: job.delivery ? { id: job.id, ...job.delivery } : undefined,
  };
}

/**
 * Convert an ORM record back to an in-memory job object.
 */
function recordToJob(record) {
  const schedule = record.schedule;
  const payload = record.payload;
  const state = record.state;
  const delivery = record.delivery;

  return {
    id: record.id,
    name: record.name,
    description: record.description,
    enabled: record.enabled,
    deleteAfterRun: record.deleteAfterRun,
    sessionTarget: record.sessionTarget,
    wakeMode: record.wakeMode,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    schedule: schedule ? {
      kind: schedule.kind,
      at: schedule.at,
      everyMs: schedule.everyMs,
      anchorMs: schedule.anchorMs,
      expr: schedule.expr,
      tz: schedule.tz,
    } : undefined,
    payload: payload ? {
      kind: payload.kind,
      message: payload.message,
      text: payload.text,
    } : undefined,
    state: state ? {
      nextRunAtMs: state.nextRunAtMs,
      runningAtMs: state.runningAtMs,
      lastRunAtMs: state.lastRunAtMs,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      lastDurationMs: state.lastDurationMs,
      consecutiveErrors: state.consecutiveErrors || 0,
      scheduleErrorCount: state.scheduleErrorCount || 0,
    } : {
      consecutiveErrors: 0,
      scheduleErrorCount: 0,
    },
    delivery: delivery ? { mode: delivery.mode } : undefined,
  };
}

/**
 * Load all persisted cron jobs from the ORM store.
 * @returns {Array} Array of in-memory job objects
 */
export function loadJobs() {
  const records = store.get('cron-job');
  if (!records) return [];

  const jobs = [];
  for (const [, record] of records) {
    jobs.push(recordToJob(record));
  }
  return jobs;
}

/**
 * Persist a job to the ORM store (create or update).
 */
export function saveJob(job) {
  const data = jobToRecord(job);
  const existing = store.get('cron-job', job.id);

  if (existing) {
    updateRecord(existing, data);
  } else {
    createRecord('cron-job', data);
  }
}

/**
 * Remove a job from the ORM store.
 */
export function removeJob(id) {
  store.remove('cron-job', id);
}

/**
 * Persist a run log entry.
 */
export function saveRun(entry) {
  createRecord('cron-run', {
    ...entry,
    ts: entry.ts || Date.now(),
  });
}

/**
 * Flush all changes to disk.
 */
export async function save() {
  await orm.db.save();
}
