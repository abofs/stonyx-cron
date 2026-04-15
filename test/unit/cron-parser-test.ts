import QUnit from 'qunit';
const { module, test } = QUnit;
import { parseField, parseCronExpression, nextOccurrence, validateCronExpression } from '../../src/cron-parser.js';

module('cron-parser | parseField', function () {
  test('wildcard returns full range', function (assert) {
    assert.deepEqual(parseField('*', 0), Array.from({ length: 60 }, (_, i) => i));
    assert.deepEqual(parseField('*', 1), Array.from({ length: 24 }, (_, i) => i));
  });

  test('single value', function (assert) {
    assert.deepEqual(parseField('5', 0), [5]);
    assert.deepEqual(parseField('23', 1), [23]);
  });

  test('range', function (assert) {
    assert.deepEqual(parseField('1-5', 0), [1, 2, 3, 4, 5]);
    assert.deepEqual(parseField('10-12', 3), [10, 11, 12]);
  });

  test('step on wildcard', function (assert) {
    assert.deepEqual(parseField('*/15', 0), [0, 15, 30, 45]);
    assert.deepEqual(parseField('*/6', 1), [0, 6, 12, 18]);
  });

  test('step on range', function (assert) {
    assert.deepEqual(parseField('1-10/3', 0), [1, 4, 7, 10]);
  });

  test('list', function (assert) {
    assert.deepEqual(parseField('1,5,10,15', 0), [1, 5, 10, 15]);
  });

  test('month names', function (assert) {
    assert.deepEqual(parseField('jan-mar', 3), [1, 2, 3]);
    assert.deepEqual(parseField('jan,jun,dec', 3), [1, 6, 12]);
  });

  test('day-of-week names', function (assert) {
    assert.deepEqual(parseField('mon-fri', 4), [1, 2, 3, 4, 5]);
    assert.deepEqual(parseField('sun,sat', 4), [0, 6]);
  });

  test('day-of-week 7 normalizes to 0 (Sunday)', function (assert) {
    assert.deepEqual(parseField('7', 4), [0]);
  });

  test('throws on out-of-range value', function (assert) {
    assert.throws(() => parseField('60', 0), /out of range/);
    assert.throws(() => parseField('25', 1), /out of range/);
  });

  test('throws on invalid step', function (assert) {
    assert.throws(() => parseField('*/0', 0), /Invalid step/);
  });
});

module('cron-parser | parseCronExpression', function () {
  test('parses standard 5-field expression', function (assert) {
    const result = parseCronExpression('0 9 * * 1-5');
    assert.deepEqual(result.minutes, [0]);
    assert.deepEqual(result.hours, [9]);
    assert.deepEqual(result.daysOfMonth, Array.from({ length: 31 }, (_, i) => i + 1));
    assert.deepEqual(result.months, Array.from({ length: 12 }, (_, i) => i + 1));
    assert.deepEqual(result.daysOfWeek, [1, 2, 3, 4, 5]);
  });

  test('throws on wrong number of fields', function (assert) {
    assert.throws(() => parseCronExpression('* * *'), /5 fields/);
    assert.throws(() => parseCronExpression('* * * * * *'), /5 fields/);
  });

  test('every minute', function (assert) {
    const result = parseCronExpression('* * * * *');
    assert.strictEqual(result.minutes.length, 60);
  });
});

module('cron-parser | nextOccurrence', function () {
  test('finds next minute for * * * * *', function (assert) {
    // Jan 15, 2026 10:30:00 UTC
    const now = new Date('2026-01-15T10:30:00Z').getTime();
    const next = nextOccurrence('* * * * *', now, 'UTC');
    // Should be 10:31
    assert.strictEqual(new Date(next!).toISOString(), '2026-01-15T10:31:00.000Z');
  });

  test('finds next occurrence for 0 9 * * *', function (assert) {
    // Jan 15, 2026 10:00:00 UTC (already past 9am)
    const now = new Date('2026-01-15T10:00:00Z').getTime();
    const next = nextOccurrence('0 9 * * *', now, 'UTC');
    // Should be next day at 9:00
    assert.strictEqual(new Date(next!).toISOString(), '2026-01-16T09:00:00.000Z');
  });

  test('finds next occurrence for 0 9 * * 1 (Mondays)', function (assert) {
    // Jan 15, 2026 is a Thursday
    const now = new Date('2026-01-15T10:00:00Z').getTime();
    const next = nextOccurrence('0 9 * * 1', now, 'UTC');
    // Next Monday is Jan 19
    assert.strictEqual(new Date(next!).toISOString(), '2026-01-19T09:00:00.000Z');
  });

  test('handles */15 minutes', function (assert) {
    const now = new Date('2026-01-15T10:07:00Z').getTime();
    const next = nextOccurrence('*/15 * * * *', now, 'UTC');
    // Next quarter-hour is 10:15
    assert.strictEqual(new Date(next!).toISOString(), '2026-01-15T10:15:00.000Z');
  });

  test('handles month rollover', function (assert) {
    // Dec 31, 2026 23:59:00 UTC
    const now = new Date('2026-12-31T23:59:00Z').getTime();
    const next = nextOccurrence('0 0 1 * *', now, 'UTC');
    // Should be Jan 1, 2027
    assert.strictEqual(new Date(next!).toISOString(), '2027-01-01T00:00:00.000Z');
  });

  test('returns undefined for impossible expression (unreachable within 4 years)', function (assert) {
    // Feb 30 never exists
    const now = new Date('2026-01-15T10:00:00Z').getTime();
    const next = nextOccurrence('0 0 30 2 *', now, 'UTC');
    assert.strictEqual(next, undefined);
  });
});

module('cron-parser | validateCronExpression', function () {
  test('validates good expression without throwing', function (assert) {
    assert.ok(true); // just checking it doesn't throw
    validateCronExpression('0 9 * * 1-5');
    validateCronExpression('*/5 * * * *');
    validateCronExpression('0 0 1 jan *');
  });

  test('throws on invalid expression', function (assert) {
    assert.throws(() => validateCronExpression('not a cron'), /5 fields/);
  });
});
