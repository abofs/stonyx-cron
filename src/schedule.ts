/**
 * Schedule types and next-run computation.
 *
 * Three schedule kinds:
 *   - "at": One-shot at an absolute ISO-8601 timestamp
 *   - "every": Recurring interval in milliseconds
 *   - "cron": 5-field cron expression with optional timezone
 */
import { nextOccurrence, validateCronExpression } from './cron-parser.js';

export interface AtSchedule { kind: 'at'; at: string | number; }
export interface EverySchedule { kind: 'every'; everyMs: number; anchorMs?: number; }
export interface CronSchedule { kind: 'cron'; expr: string; tz?: string; }
export type Schedule = AtSchedule | EverySchedule | CronSchedule;

/**
 * Compute the next run time for a schedule.
 */
export function computeNextRunAtMs(schedule: Schedule, nowMs: number): number | undefined {
  if (schedule.kind === 'at') {
    const atMs = typeof schedule.at === 'number' ? schedule.at : Date.parse(schedule.at);
    if (!Number.isFinite(atMs)) return undefined;
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === 'every') {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));

    if (nowMs < anchor) return anchor;

    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  if (schedule.kind === 'cron') {
    const tz = schedule.tz?.trim() || undefined;
    // Round nowMs down to the current second to avoid sub-second drift
    const nowSecondMs = Math.floor(nowMs / 1000) * 1000;
    return nextOccurrence(schedule.expr.trim(), nowSecondMs, tz);
  }

  throw new Error(`Unknown schedule kind: "${(schedule as Record<string, unknown>).kind}"`);
}

/**
 * Validate a schedule definition.
 */
export function validateSchedule(schedule: Schedule): void {
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('Schedule must be an object');
  }

  if (schedule.kind === 'at') {
    const atMs = typeof schedule.at === 'number' ? schedule.at : Date.parse(schedule.at);
    if (!Number.isFinite(atMs)) {
      throw new Error(`Invalid "at" timestamp: "${schedule.at}"`);
    }
    return;
  }

  if (schedule.kind === 'every') {
    if (typeof schedule.everyMs !== 'number' || schedule.everyMs < 1) {
      throw new Error(`"every" schedule requires everyMs >= 1, got: ${schedule.everyMs}`);
    }
    return;
  }

  if (schedule.kind === 'cron') {
    if (typeof schedule.expr !== 'string' || !schedule.expr.trim()) {
      throw new Error('"cron" schedule requires a non-empty expr string');
    }
    validateCronExpression(schedule.expr.trim());
    return;
  }

  throw new Error(`Unknown schedule kind: "${(schedule as Record<string, unknown>).kind}"`);
}
