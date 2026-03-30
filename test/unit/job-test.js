import QUnit from 'qunit';
const { module, test } = QUnit;
import { createJob, updateJob, markRunning, applyResult, isDue, errorBackoffMs } from '../../src/job.js';

function makeSchedule() {
  return { kind: 'every', everyMs: 60_000 };
}

function makePayload() {
  return { kind: 'agentTurn', message: 'test' };
}

module('job | createJob', function () {
  test('creates a job with defaults', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });

    assert.ok(job.id, 'has UUID');
    assert.strictEqual(job.name, 'Test');
    assert.strictEqual(job.enabled, true);
    assert.strictEqual(job.sessionTarget, 'isolated');
    assert.strictEqual(job.wakeMode, 'now');
    assert.ok(job.state.nextRunAtMs, 'nextRunAtMs computed');
    assert.strictEqual(job.state.consecutiveErrors, 0);
  });

  test('sets deleteAfterRun true for one-shot', function (assert) {
    const future = new Date(Date.now() + 60_000).toISOString();
    const job = createJob({ name: 'Once', schedule: { kind: 'at', at: future }, payload: makePayload() });
    assert.strictEqual(job.deleteAfterRun, true);
  });

  test('respects enabled=false', function (assert) {
    const job = createJob({ name: 'Off', schedule: makeSchedule(), payload: makePayload(), enabled: false });
    assert.strictEqual(job.enabled, false);
    assert.strictEqual(job.state.nextRunAtMs, undefined);
  });
});

module('job | updateJob', function () {
  test('updates name and description', function (assert) {
    const job = createJob({ name: 'Old', schedule: makeSchedule(), payload: makePayload() });
    updateJob(job, { name: 'New', description: 'Updated' });
    assert.strictEqual(job.name, 'New');
    assert.strictEqual(job.description, 'Updated');
  });

  test('recomputes nextRunAtMs on schedule change', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    const oldNext = job.state.nextRunAtMs;
    updateJob(job, { schedule: { kind: 'every', everyMs: 120_000 } });
    assert.notStrictEqual(job.state.nextRunAtMs, oldNext);
  });

  test('disabling clears nextRunAtMs', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    updateJob(job, { enabled: false });
    assert.strictEqual(job.state.nextRunAtMs, undefined);
  });

  test('re-enabling computes nextRunAtMs', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload(), enabled: false });
    updateJob(job, { enabled: true });
    assert.ok(job.state.nextRunAtMs);
  });
});

module('job | markRunning', function () {
  test('sets runningAtMs', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    markRunning(job);
    assert.ok(job.state.runningAtMs);
  });
});

module('job | applyResult', function () {
  test('success resets consecutiveErrors', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    markRunning(job);
    job.state.consecutiveErrors = 3;
    applyResult(job, 'ok');
    assert.strictEqual(job.state.consecutiveErrors, 0);
    assert.strictEqual(job.state.lastStatus, 'ok');
    assert.strictEqual(job.state.runningAtMs, undefined);
  });

  test('error increments consecutiveErrors', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    markRunning(job);
    applyResult(job, 'error', 'boom');
    assert.strictEqual(job.state.consecutiveErrors, 1);
    assert.strictEqual(job.state.lastError, 'boom');
  });

  test('error applies backoff', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    markRunning(job);
    applyResult(job, 'error', 'fail');
    // nextRunAtMs should be at least 30s from now (first backoff)
    assert.ok(job.state.nextRunAtMs >= Date.now() + 25_000);
  });

  test('one-shot disables after any terminal status', function (assert) {
    const future = new Date(Date.now() + 60_000).toISOString();
    const job = createJob({ name: 'Once', schedule: { kind: 'at', at: future }, payload: makePayload() });
    markRunning(job);
    applyResult(job, 'ok');
    assert.strictEqual(job.enabled, false);
    assert.strictEqual(job.state.nextRunAtMs, undefined);
  });
});

module('job | isDue', function () {
  test('returns true when enabled, not running, and past due', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    job.state.nextRunAtMs = Date.now() - 1000;
    assert.ok(isDue(job, Date.now()));
  });

  test('returns false when disabled', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload(), enabled: false });
    job.state.nextRunAtMs = Date.now() - 1000;
    assert.notOk(isDue(job, Date.now()));
  });

  test('returns false when running', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    job.state.nextRunAtMs = Date.now() - 1000;
    markRunning(job);
    assert.notOk(isDue(job, Date.now()));
  });

  test('returns false when not yet due', function (assert) {
    const job = createJob({ name: 'Test', schedule: makeSchedule(), payload: makePayload() });
    job.state.nextRunAtMs = Date.now() + 60_000;
    assert.notOk(isDue(job, Date.now()));
  });
});

module('job | errorBackoffMs', function () {
  test('returns correct backoff values', function (assert) {
    assert.strictEqual(errorBackoffMs(0), 0);
    assert.strictEqual(errorBackoffMs(1), 30_000);
    assert.strictEqual(errorBackoffMs(2), 60_000);
    assert.strictEqual(errorBackoffMs(3), 300_000);
    assert.strictEqual(errorBackoffMs(4), 900_000);
    assert.strictEqual(errorBackoffMs(5), 3_600_000);
    assert.strictEqual(errorBackoffMs(100), 3_600_000, 'caps at max');
  });
});
