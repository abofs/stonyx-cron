import QUnit from 'qunit';
const { module, test } = QUnit;
import { normalizeSchedule, normalizePayload, recoverFlatParams, normalizeJobInput } from '../../src/normalize.js';

module('normalize | normalizeSchedule', function () {
  test('infers kind from at field', function (assert) {
    const result = normalizeSchedule({ at: '2026-01-01T00:00:00Z' });
    assert.strictEqual(result.kind, 'at');
  });

  test('infers kind from everyMs field', function (assert) {
    const result = normalizeSchedule({ everyMs: 5000 });
    assert.strictEqual(result.kind, 'every');
  });

  test('infers kind from expr field', function (assert) {
    const result = normalizeSchedule({ expr: '0 9 * * *' });
    assert.strictEqual(result.kind, 'cron');
  });

  test('converts atMs to at ISO string', function (assert) {
    const ms = new Date('2026-06-15T12:00:00Z').getTime();
    const result = normalizeSchedule({ atMs: ms });
    assert.strictEqual(result.at, '2026-06-15T12:00:00.000Z');
    assert.strictEqual(result.atMs, undefined);
  });

  test('normalizes kind casing', function (assert) {
    const result = normalizeSchedule({ kind: 'CRON', expr: '0 9 * * *' });
    assert.strictEqual(result.kind, 'cron');
  });

  test('coerces string everyMs to number', function (assert) {
    const result = normalizeSchedule({ kind: 'every', everyMs: '5000' });
    assert.strictEqual(result.everyMs, 5000);
  });
});

module('normalize | normalizePayload', function () {
  test('infers agentTurn from message field', function (assert) {
    const result = normalizePayload({ message: 'hello' });
    assert.strictEqual(result.kind, 'agentTurn');
  });

  test('infers systemEvent from text field', function (assert) {
    const result = normalizePayload({ text: 'event' });
    assert.strictEqual(result.kind, 'systemEvent');
  });

  test('normalizes kind casing', function (assert) {
    assert.strictEqual(normalizePayload({ kind: 'agentturn' }).kind, 'agentTurn');
    assert.strictEqual(normalizePayload({ kind: 'SYSTEMEVENT' }).kind, 'systemEvent');
  });
});

module('normalize | recoverFlatParams', function () {
  test('returns job if it exists and has content', function (assert) {
    const input = { job: { name: 'test', schedule: {} } };
    assert.strictEqual(recoverFlatParams(input), input.job);
  });

  test('recovers from flat params', function (assert) {
    const input = { name: 'test', schedule: { kind: 'every', everyMs: 5000 }, payload: { kind: 'agentTurn', message: 'hi' } };
    const result = recoverFlatParams(input);
    assert.strictEqual(result.name, 'test');
    assert.ok(result.schedule);
    assert.ok(result.payload);
  });

  test('wraps bare message into payload', function (assert) {
    const input = { name: 'test', schedule: { kind: 'every', everyMs: 5000 }, message: 'do things' };
    const result = recoverFlatParams(input);
    assert.strictEqual(result.payload.kind, 'agentTurn');
    assert.strictEqual(result.payload.message, 'do things');
  });

  test('wraps bare text into payload', function (assert) {
    const input = { schedule: { kind: 'at', at: '2026-01-01' }, text: 'wake up' };
    const result = recoverFlatParams(input);
    assert.strictEqual(result.payload.kind, 'systemEvent');
    assert.strictEqual(result.payload.text, 'wake up');
  });
});

module('normalize | normalizeJobInput', function () {
  test('applies defaults', function (assert) {
    const result = normalizeJobInput({
      schedule: { kind: 'every', everyMs: 5000 },
      payload: { kind: 'agentTurn', message: 'test' },
    });

    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.wakeMode, 'now');
    assert.strictEqual(result.sessionTarget, 'isolated');
    assert.ok(result.name, 'name auto-generated');
  });

  test('infers sessionTarget from payload kind', function (assert) {
    const sys = normalizeJobInput({
      schedule: { kind: 'every', everyMs: 5000 },
      payload: { kind: 'systemEvent', text: 'test' },
    });
    assert.strictEqual(sys.sessionTarget, 'main');

    const agent = normalizeJobInput({
      schedule: { kind: 'every', everyMs: 5000 },
      payload: { kind: 'agentTurn', message: 'test' },
    });
    assert.strictEqual(agent.sessionTarget, 'isolated');
  });

  test('auto-generates delivery for isolated agentTurn', function (assert) {
    const result = normalizeJobInput({
      schedule: { kind: 'every', everyMs: 5000 },
      payload: { kind: 'agentTurn', message: 'test' },
    });
    assert.deepEqual(result.delivery, { mode: 'announce' });
  });

  test('sets deleteAfterRun for one-shot', function (assert) {
    const result = normalizeJobInput({
      schedule: { kind: 'at', at: '2026-01-01T00:00:00Z' },
      payload: { kind: 'agentTurn', message: 'test' },
    });
    assert.strictEqual(result.deleteAfterRun, true);
  });
});
