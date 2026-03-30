import QUnit from 'qunit';
const { module, test } = QUnit;
import { computeNextRunAtMs, validateSchedule } from '../../src/schedule.js';

module('schedule | computeNextRunAtMs', function () {
  module('kind: at', function () {
    test('returns timestamp if in the future', function (assert) {
      const future = Date.now() + 60_000;
      const result = computeNextRunAtMs({ kind: 'at', at: new Date(future).toISOString() }, Date.now());
      assert.strictEqual(result, future);
    });

    test('returns undefined if in the past', function (assert) {
      const past = Date.now() - 60_000;
      const result = computeNextRunAtMs({ kind: 'at', at: new Date(past).toISOString() }, Date.now());
      assert.strictEqual(result, undefined);
    });

    test('accepts numeric timestamp', function (assert) {
      const future = Date.now() + 60_000;
      const result = computeNextRunAtMs({ kind: 'at', at: future }, Date.now());
      assert.strictEqual(result, future);
    });

    test('returns undefined for invalid timestamp', function (assert) {
      const result = computeNextRunAtMs({ kind: 'at', at: 'not-a-date' }, Date.now());
      assert.strictEqual(result, undefined);
    });
  });

  module('kind: every', function () {
    test('returns anchor if now < anchor', function (assert) {
      const anchor = Date.now() + 10_000;
      const result = computeNextRunAtMs({ kind: 'every', everyMs: 5000, anchorMs: anchor }, Date.now());
      assert.strictEqual(result, anchor);
    });

    test('returns next interval after now', function (assert) {
      const anchor = 1000;
      const now = 12_500;
      // everyMs=5000, anchor=1000, elapsed=11500, steps=ceil(11500/5000)=3, next=1000+3*5000=16000
      const result = computeNextRunAtMs({ kind: 'every', everyMs: 5000, anchorMs: anchor }, now);
      assert.strictEqual(result, 16_000);
    });

    test('defaults anchor to now', function (assert) {
      const now = Date.now();
      const result = computeNextRunAtMs({ kind: 'every', everyMs: 10_000 }, now);
      assert.strictEqual(result, now + 10_000);
    });

    test('enforces minimum everyMs of 1', function (assert) {
      const now = Date.now();
      const result = computeNextRunAtMs({ kind: 'every', everyMs: 0 }, now);
      assert.ok(result > now);
    });
  });

  module('kind: cron', function () {
    test('delegates to cron parser', function (assert) {
      const now = new Date('2026-01-15T10:30:00Z').getTime();
      const result = computeNextRunAtMs({ kind: 'cron', expr: '* * * * *', tz: 'UTC' }, now);
      assert.strictEqual(new Date(result).toISOString(), '2026-01-15T10:31:00.000Z');
    });
  });

  test('throws on unknown kind', function (assert) {
    assert.throws(() => computeNextRunAtMs({ kind: 'unknown' }, Date.now()), /Unknown schedule kind/);
  });
});

module('schedule | validateSchedule', function () {
  test('validates at schedule', function (assert) {
    validateSchedule({ kind: 'at', at: new Date().toISOString() });
    assert.ok(true);
  });

  test('validates every schedule', function (assert) {
    validateSchedule({ kind: 'every', everyMs: 5000 });
    assert.ok(true);
  });

  test('validates cron schedule', function (assert) {
    validateSchedule({ kind: 'cron', expr: '0 9 * * *' });
    assert.ok(true);
  });

  test('throws on missing schedule', function (assert) {
    assert.throws(() => validateSchedule(null), /must be an object/);
  });

  test('throws on invalid at timestamp', function (assert) {
    assert.throws(() => validateSchedule({ kind: 'at', at: 'nope' }), /Invalid/);
  });

  test('throws on invalid everyMs', function (assert) {
    assert.throws(() => validateSchedule({ kind: 'every', everyMs: -1 }), /everyMs/);
  });

  test('throws on empty cron expr', function (assert) {
    assert.throws(() => validateSchedule({ kind: 'cron', expr: '' }), /non-empty/);
  });

  test('throws on unknown kind', function (assert) {
    assert.throws(() => validateSchedule({ kind: 'banana' }), /Unknown schedule kind/);
  });
});
