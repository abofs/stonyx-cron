/**
 * Input normalization for AI-generated job definitions.
 * Handles imperfect JSON from AI models: wrong casing, missing fields,
 * flat-param recovery, type coercion.
 */

/**
 * Normalize a schedule object. Infers kind from fields if missing.
 */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return raw;

  const schedule = { ...raw };

  // Infer kind from fields if missing
  if (!schedule.kind) {
    if (schedule.at || schedule.atMs) schedule.kind = 'at';
    else if (schedule.everyMs) schedule.kind = 'every';
    else if (schedule.expr) schedule.kind = 'cron';
  }

  // Case normalization
  if (typeof schedule.kind === 'string') {
    schedule.kind = schedule.kind.toLowerCase();
  }

  // Legacy: atMs (number) → at (ISO string)
  if (schedule.atMs && !schedule.at) {
    schedule.at = new Date(schedule.atMs).toISOString();
    delete schedule.atMs;
  }

  // Coerce string everyMs to number
  if (typeof schedule.everyMs === 'string') {
    schedule.everyMs = Number(schedule.everyMs);
  }

  return schedule;
}

/**
 * Normalize a payload object. Infers kind from fields if missing.
 */
export function normalizePayload(raw) {
  if (!raw || typeof raw !== 'object') return raw;

  const payload = { ...raw };

  // Infer kind from fields
  if (!payload.kind) {
    if (payload.message) payload.kind = 'agentTurn';
    else if (payload.text) payload.kind = 'systemEvent';
  }

  // Case normalization
  if (typeof payload.kind === 'string') {
    const lower = payload.kind.toLowerCase();
    if (lower === 'agentturn') payload.kind = 'agentTurn';
    else if (lower === 'systemevent') payload.kind = 'systemEvent';
  }

  return payload;
}

/**
 * Recover a job object from flat parameters.
 * AI models sometimes flatten nested fields to the top level.
 */
const JOB_KEYS = new Set([
  'name', 'description', 'schedule', 'sessionTarget', 'payload',
  'delivery', 'enabled', 'deleteAfterRun', 'wakeMode',
]);

export function recoverFlatParams(params) {
  if (params.job && typeof params.job === 'object' && Object.keys(params.job).length > 0) {
    return params.job;
  }

  const synthetic = {};
  for (const key of Object.keys(params)) {
    if (JOB_KEYS.has(key)) {
      synthetic[key] = params[key];
    }
  }

  // message/text are not JOB_KEYS but need to be recovered for payload wrapping
  const message = params.message;
  const text = params.text;

  if (synthetic.schedule || synthetic.payload || message || text) {
    // If message/text are at top level, wrap into payload
    if (!synthetic.payload) {
      if (message) {
        synthetic.payload = { kind: 'agentTurn', message };
      } else if (text) {
        synthetic.payload = { kind: 'systemEvent', text };
      }
    }
    return synthetic;
  }

  return params;
}

/**
 * Normalize a complete job input for creation.
 * Applies all normalization: schedule, payload, defaults.
 */
export function normalizeJobInput(raw) {
  const job = { ...raw };

  if (job.schedule) {
    job.schedule = normalizeSchedule(job.schedule);
  }

  if (job.payload) {
    job.payload = normalizePayload(job.payload);
  }

  // Default: enabled
  if (job.enabled === undefined) job.enabled = true;

  // Default: wakeMode
  if (!job.wakeMode) job.wakeMode = 'now';

  // Default: sessionTarget inferred from payload
  if (!job.sessionTarget && job.payload) {
    job.sessionTarget = job.payload.kind === 'systemEvent' ? 'main' : 'isolated';
  }

  // Default: deleteAfterRun for one-shot
  if (job.deleteAfterRun === undefined && job.schedule?.kind === 'at') {
    job.deleteAfterRun = true;
  }

  // Default: delivery for isolated agentTurn
  if (!job.delivery && job.sessionTarget === 'isolated' && job.payload?.kind === 'agentTurn') {
    job.delivery = { mode: 'announce' };
  }

  // Auto-generate name if missing
  if (!job.name) {
    job.name = inferName(job);
  }

  return job;
}

/**
 * Infer a job name from schedule and payload.
 */
function inferName(job) {
  const parts = [];

  if (job.schedule?.kind === 'at') parts.push('One-shot');
  else if (job.schedule?.kind === 'every') parts.push('Recurring');
  else if (job.schedule?.kind === 'cron') parts.push('Scheduled');

  if (job.payload?.kind === 'agentTurn') parts.push('agent task');
  else if (job.payload?.kind === 'systemEvent') parts.push('system event');

  return parts.join(' ') || 'Unnamed job';
}
