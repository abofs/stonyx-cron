/**
 * 5-field cron expression parser with next-occurrence computation.
 * No external dependencies — built for stonyx-cron.
 *
 * Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6)
 * Supports: wildcards(*), ranges(1-5), steps(* /5), lists(1,3,5), names(jan-dec, sun-sat)
 */

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELD_RANGES = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // day of week
];

/**
 * Parse a single cron field into a sorted array of allowed values.
 * @param {string} field - The field string (e.g., "1-5", "* /15", "mon,wed,fri")
 * @param {number} fieldIndex - Index (0=minute, 1=hour, 2=dom, 3=month, 4=dow)
 * @returns {number[]} Sorted array of allowed integer values
 */
export function parseField(field, fieldIndex) {
  const { min, max } = FIELD_RANGES[fieldIndex];
  const names = fieldIndex === 3 ? MONTH_NAMES : fieldIndex === 4 ? DAY_NAMES : null;

  const resolveToken = (token) => {
    if (names) {
      const lower = token.toLowerCase();
      if (lower in names) return names[lower];
    }
    const n = Number(token);
    if (!Number.isInteger(n)) throw new Error(`Invalid cron value: "${token}" in field ${fieldIndex}`);
    // Normalize day-of-week 7 → 0 (both mean Sunday)
    if (fieldIndex === 4 && n === 7) return 0;
    return n;
  };

  const results = new Set();

  for (const part of field.split(',')) {
    const trimmed = part.trim();
    const [rangeStr, stepStr] = trimmed.split('/');
    const step = stepStr !== undefined ? Number(stepStr) : 1;

    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid step "${stepStr}" in cron field ${fieldIndex}`);
    }

    let start, end;

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
 * @param {string} expr - Cron expression (e.g., "0 9 * * 1-5")
 * @returns {{ minutes: number[], hours: number[], daysOfMonth: number[], months: number[], daysOfWeek: number[] }}
 */
export function parseCronExpression(expr) {
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
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Check if a day-of-month + day-of-week pair matches the parsed expression.
 *
 * Standard cron behavior: if BOTH dom and dow are restricted (not *),
 * then EITHER matching is sufficient (OR logic).
 * If only one is restricted, it acts as the sole filter.
 */
function dayMatches(parsed, domWild, dowWild, dayOfMonth, dayOfWeek) {
  const domMatch = parsed.daysOfMonth.includes(dayOfMonth);
  const dowMatch = parsed.daysOfWeek.includes(dayOfWeek);

  if (domWild && dowWild) return true;
  if (domWild) return dowMatch;
  if (dowWild) return domMatch;
  return domMatch || dowMatch; // Both restricted → OR
}

/**
 * Compute the next occurrence of a cron expression after a given timestamp.
 *
 * @param {string} expr - 5-field cron expression
 * @param {number} afterMs - Timestamp in milliseconds (exclusive — finds strictly after this)
 * @param {string} [tz] - IANA timezone (defaults to system timezone)
 * @returns {number|undefined} Next occurrence in milliseconds, or undefined if none within 4 years
 */
export function nextOccurrence(expr, afterMs, tz) {
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

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // Parse formatted date parts in the target timezone
  function getLocalParts(date) {
    const parts = {};
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

  // Search limit: 4 years of minutes (≈ 2.1M iterations max)
  const maxMs = afterMs + 4 * 365.25 * 24 * 60 * 60 * 1000;
  let candidate = new Date(startDate);

  while (candidate.getTime() <= maxMs) {
    const p = getLocalParts(candidate);

    // Check month
    if (!parsed.months.includes(p.month)) {
      // Advance to next matching month
      const nextMonth = parsed.months.find(m => m > p.month);
      if (nextMonth) {
        // Stay in same year, advance to first day of nextMonth
        candidate = advanceToMonth(candidate, p.year, nextMonth, tz, formatter, dayMap);
      } else {
        // Wrap to next year, first matching month
        candidate = advanceToMonth(candidate, p.year + 1, parsed.months[0], tz, formatter, dayMap);
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
        // Advance to next day
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
        // Advance to next hour
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
 * Create a Date advanced to the start of a specific month in a specific year,
 * using the target timezone's midnight.
 */
function advanceToMonth(current, year, month, tz, formatter, dayMap) {
  // Create a new date at ~start of the target month in UTC, then adjust
  const d = new Date(current);
  // Jump to approximately the right time
  d.setFullYear(year, month - 1, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Validate a cron expression without computing next occurrence.
 * @param {string} expr - 5-field cron expression
 * @throws {Error} if the expression is invalid
 */
export function validateCronExpression(expr) {
  parseCronExpression(expr);
}
