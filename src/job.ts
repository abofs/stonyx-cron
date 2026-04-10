/**
 * Job data model and state machine for the advanced scheduling system.
 */
import { computeNextRunAtMs, validateSchedule, type Schedule } from './schedule.js';

/**
 * Error backoff table (milliseconds).
 * Applied after consecutive errors to prevent hammering.
 */
const ERROR_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export interface JobState {
  nextRunAtMs: number | undefined;
  runningAtMs: number | undefined;
  lastRunAtMs: number | undefined;
  lastStatus: 'ok' | 'error' | 'skipped' | undefined;
  lastError: string | undefined;
  lastDurationMs: number | undefined;
  consecutiveErrors: number;
  scheduleErrorCount: number;
}

export interface Job {
  id: string;
  name: string;
  description: string | undefined;
  enabled: boolean;
  deleteAfterRun: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: Schedule;
  sessionTarget: string;
  wakeMode: string;
  payload: Record<string, unknown>;
  delivery: Record<string, unknown> | undefined;
  state: JobState;
}

export interface JobInput {
  name: string;
  schedule: Schedule;
  payload: Record<string, unknown>;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  sessionTarget?: string;
  wakeMode?: string;
  delivery?: Record<string, unknown>;
}

export interface JobPatch {
  name?: string;
  description?: string;
  schedule?: Schedule;
  payload?: Record<string, unknown>;
  delivery?: Record<string, unknown> | null;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  sessionTarget?: string;
  wakeMode?: string;
}

export function errorBackoffMs(consecutiveErrors: number): number {
  if (consecutiveErrors < 1) return 0;
  return ERROR_BACKOFF_MS[Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)];
}

/**
 * Create a new job object from input.
 */
export function createJob(input: JobInput): Job {
  validateSchedule(input.schedule);

  const nowMs = Date.now();
  const enabled = input.enabled !== false;
  const deleteAfterRun = input.deleteAfterRun ?? (input.schedule.kind === 'at');

  const job: Job = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description || undefined,
    enabled,
    deleteAfterRun,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { ...input.schedule },
    sessionTarget: input.sessionTarget || 'isolated',
    wakeMode: input.wakeMode || 'now',
    payload: { ...input.payload },
    delivery: input.delivery ? { ...input.delivery } : undefined,
    state: {
      nextRunAtMs: undefined,
      runningAtMs: undefined,
      lastRunAtMs: undefined,
      lastStatus: undefined,
      lastError: undefined,
      lastDurationMs: undefined,
      consecutiveErrors: 0,
      scheduleErrorCount: 0,
    },
  };

  // Compute initial next run
  if (enabled) {
    try {
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
    } catch {
      job.state.scheduleErrorCount = 1;
    }
  }

  return job;
}

/**
 * Apply an update patch to a job.
 */
export function updateJob(job: Job, patch: JobPatch): Job {
  const nowMs = Date.now();

  if (patch.name !== undefined) job.name = patch.name;
  if (patch.description !== undefined) job.description = patch.description || undefined;
  if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;
  if (patch.sessionTarget !== undefined) job.sessionTarget = patch.sessionTarget;
  if (patch.wakeMode !== undefined) job.wakeMode = patch.wakeMode;
  if (patch.payload !== undefined) job.payload = { ...patch.payload };
  if (patch.delivery !== undefined) job.delivery = patch.delivery ? { ...patch.delivery } : undefined;

  if (patch.schedule !== undefined) {
    validateSchedule(patch.schedule);
    job.schedule = { ...patch.schedule };
    job.state.scheduleErrorCount = 0;
    // Recompute next run
    if (job.enabled) {
      try {
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
      } catch {
        job.state.scheduleErrorCount = 1;
      }
    }
  }

  if (patch.enabled !== undefined) {
    job.enabled = patch.enabled;
    if (job.enabled && !job.state.nextRunAtMs) {
      try {
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
      } catch {
        job.state.scheduleErrorCount++;
      }
    }
    if (!job.enabled) {
      job.state.nextRunAtMs = undefined;
    }
  }

  job.updatedAtMs = nowMs;
  return job;
}

/**
 * Mark a job as started (running).
 */
export function markRunning(job: Job): void {
  job.state.runningAtMs = Date.now();
}

/**
 * Apply the result of a job execution.
 */
export function applyResult(job: Job, status: 'ok' | 'error' | 'skipped', error?: string, durationMs?: number): void {
  const nowMs = Date.now();

  job.state.lastRunAtMs = job.state.runningAtMs || nowMs;
  job.state.runningAtMs = undefined;
  job.state.lastStatus = status;
  job.state.lastError = status === 'error' ? error : undefined;
  job.state.lastDurationMs = durationMs;

  if (status === 'error') {
    job.state.consecutiveErrors = (job.state.consecutiveErrors || 0) + 1;
  } else {
    job.state.consecutiveErrors = 0;
  }

  // One-shot jobs: disable after any terminal status
  if (job.schedule.kind === 'at') {
    job.enabled = false;
    job.state.nextRunAtMs = undefined;
    return;
  }

  // Recurring jobs: compute next run with backoff
  if (job.enabled) {
    try {
      const normalNext = computeNextRunAtMs(job.schedule, nowMs);
      if (normalNext === undefined) {
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
        return;
      }

      if (status === 'error' && job.state.consecutiveErrors > 0) {
        const backoff = errorBackoffMs(job.state.consecutiveErrors);
        job.state.nextRunAtMs = Math.max(normalNext, nowMs + backoff);
      } else {
        job.state.nextRunAtMs = normalNext;
      }

      job.state.scheduleErrorCount = 0;
    } catch {
      job.state.scheduleErrorCount = (job.state.scheduleErrorCount || 0) + 1;
      // Auto-disable after 3 consecutive schedule computation errors
      if (job.state.scheduleErrorCount >= 3) {
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      }
    }
  }
}

/**
 * Check if a job is due to run.
 */
export function isDue(job: Job, nowMs: number): boolean {
  return job.enabled
    && !job.state.runningAtMs
    && job.state.nextRunAtMs !== undefined
    && job.state.nextRunAtMs <= nowMs;
}
