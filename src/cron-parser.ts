/**
 * 5-field cron expression parser with next-occurrence computation.
 * No external dependencies - built for stonyx-cron.
 *
 * Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6)
 * Supports: wildcards(*), ranges(1-5), steps(* /5), lists(1,3,5), names(jan-dec, sun-sat)
 */

interface FieldRange {
  min: number;
  max: number;
}

export interface ParsedCronExpression {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // day of week
];

/**
 * Parse a single cron field into a sorted array of allowed values.
 */
export function parseField(field: string, fieldIndex: number): number[] {
  const { min, max } = FIELD_RANGES[fieldIndex];
  const names = fieldIndex === 3 ? MONTH_NAMES : fieldIndex === 4 ? DAY_NAMES : null;

  const resolveToken = (token: string): number => {
    if (names) {
      const lower = token.toLowerCase();
      if (lower in names) return names[lower];
    }
    const n = Number(token);
    if (!Number.isInteger(n)) throw new Error(`Invalid cron value: "${token}" in field ${fieldIndex}`);
    // Normalize day-of-week 7 -> 0 (both mean Sunday)
    if (fieldIndex === 4 && n === 7) return 0;
    return n;
  };

  const results = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();
    const [rangeStr, stepStr] = trimmed.split('/');
    const step = stepStr !== undefined ? Number(stepStr) : 1;

    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid step "${stepStr}" in cron field ${fieldIndex}`);
    }

    let start: number, end: number;

    if (rangeStr === '*') {
      start = min;
      end = max;
    } else if (rangeStr.includes('-')) {
      const [lo, hi] = rangeStr.split('-');
      start = resolveToken(lo);
      end = resolveToken(hi);
    } else {
      start = resolveToken(rangeStr);
      end = stepStr !== undefined ? max : start;
    }

    if (start < min || start > max || end < min || end > max) {
      throw new Error(`Value out of range [${min}-${max}] in cron field ${fieldIndex}: "${trimmed}"`);
    }

    for (let v = start; v <= end; v += step) {
      results.add(v);
    }
  }

  return [...results].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression into field arrays.
 */
export function parseCronExpression(expr: string): ParsedCronExpression {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`);
  }

  return {
    minutes: parseField(fields[0], 0),
    hours: parseField(fields[1], 1),
    daysOfMonth: parseField(fields[2], 2),
    months: parseField(fields[3], 3),
    daysOfWeek: parseField(fields[4], 4),
  };
}

/**
 * Get the number of days in a given month/year.
 */
function daysInMonth(_year: number, month: number): number {
  return new Date(_year, month, 0).getDate();
}

/**
 * Check if a day-of-month + day-of-week pair matches the parsed expression.
 */
function dayMatches(parsed: ParsedCronExpression, domWild: boolean, dowWild: boolean, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = parsed.daysOfMonth.includes(dayOfMonth);
  const dowMatch = parsed.daysOfWeek.includes(dayOfWeek);

  if (domWild && dowWild) return true;
  if (domWild) return dowMatch;
  if (dowWild) return domMatch;
  return domMatch || dowMatch; // Both restricted -> OR
}

/**
 * Compute the next occurrence of a cron expression after a given timestamp.
 */
export function nextOccurrence(expr: string, afterMs: number, tz?: string): number | undefined {
  const parsed = parseCronExpression(expr);
  const exprFields = expr.trim().split(/\s+/);
  const domWild = exprFields[2] === '*';
  const dowWild = exprFields[4] === '*';

  // Start from the next whole minute after afterMs
  const startDate = new Date(afterMs);
  startDate.setSeconds(0, 0);
  startDate.setMinutes(startDate.getMinutes() + 1);

  // Convert to target timezone for field matching
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || undefined,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
    weekday: 'short',
  });

  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // Parse formatted date parts in the target timezone
  function getLocalParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
    const parts: Record<string, string> = {};
    for (const { type, value } of formatter.formatToParts(date)) {
      parts[type] = value;
    }
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour === '24' ? 0 : parts.hour),
      minute: Number(parts.minute),
      weekday: dayMap[parts.weekday] ?? 0,
    };
  }

  // Search limit: 4 years of minutes
  const maxMs = afterMs + 4 * 365.25 * 24 * 60 * 60 * 1000;
  const candidate = new Date(startDate);

  while (candidate.getTime() <= maxMs) {
    const p = getLocalParts(candidate);

    // Check month
    if (!parsed.months.includes(p.month)) {
      const nextMonth = parsed.months.find(m => m > p.month);
      if (nextMonth) {
        advanceToMonth(candidate, p.year, nextMonth);
      } else {
        advanceToMonth(candidate, p.year + 1, parsed.months[0]);
      }
      continue;
    }

    // Check day (dom + dow)
    if (!dayMatches(parsed, domWild, dowWild, p.day, p.weekday)) {
      candidate.setMinutes(candidate.getMinutes() + (24 * 60 - p.hour * 60 - p.minute));
      continue;
    }

    // Check hour
    if (!parsed.hours.includes(p.hour)) {
      const nextHour = parsed.hours.find(h => h > p.hour);
      if (nextHour) {
        candidate.setMinutes(candidate.getMinutes() + ((nextHour - p.hour) * 60 - p.minute));
      } else {
        candidate.setMinutes(candidate.getMinutes() + ((24 - p.hour) * 60 - p.minute));
      }
      continue;
    }

    // Check minute
    if (!parsed.minutes.includes(p.minute)) {
      const nextMin = parsed.minutes.find(m => m > p.minute);
      if (nextMin) {
        candidate.setMinutes(candidate.getMinutes() + (nextMin - p.minute));
      } else {
        candidate.setMinutes(candidate.getMinutes() + (60 - p.minute));
      }
      continue;
    }

    // All fields match
    return candidate.getTime();
  }

  return undefined;
}

/**
 * Advance a Date to the start of a specific month in a specific year.
 */
function advanceToMonth(current: Date, year: number, month: number): void {
  current.setFullYear(year, month - 1, 1);
  current.setHours(0, 0, 0, 0);
}

/**
 * Validate a cron expression without computing next occurrence.
 */
export function validateCronExpression(expr: string): void {
  parseCronExpression(expr);
}
