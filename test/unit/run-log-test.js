import QUnit from 'qunit';
const { module, test } = QUnit;
import RunLog from '../../src/run-log.js';

module('RunLog', function () {
  test('records and retrieves entries', function (assert) {
    const log = new RunLog();
    log.record({ jobId: 'j1', status: 'ok', durationMs: 100 });
    log.record({ jobId: 'j1', status: 'error', error: 'boom', durationMs: 50 });

    const entries = log.get('j1');
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].status, 'error', 'newest first');
    assert.strictEqual(entries[1].status, 'ok');
  });

  test('returns empty array for unknown job', function (assert) {
    const log = new RunLog();
    assert.deepEqual(log.get('unknown'), []);
  });

  test('respects limit', function (assert) {
    const log = new RunLog();
    for (let i = 0; i < 10; i++) {
      log.record({ jobId: 'j1', status: 'ok' });
    }

    assert.strictEqual(log.get('j1', 3).length, 3);
  });

  test('auto-prunes beyond max entries', function (assert) {
    const log = new RunLog(5);
    for (let i = 0; i < 10; i++) {
      log.record({ jobId: 'j1', status: 'ok' });
    }

    // Internal storage should be capped at 5
    assert.strictEqual(log.get('j1', 100).length, 5);
  });

  test('removeJob clears entries', function (assert) {
    const log = new RunLog();
    log.record({ jobId: 'j1', status: 'ok' });
    log.removeJob('j1');
    assert.deepEqual(log.get('j1'), []);
  });

  test('clear removes all entries', function (assert) {
    const log = new RunLog();
    log.record({ jobId: 'j1', status: 'ok' });
    log.record({ jobId: 'j2', status: 'ok' });
    log.clear();
    assert.deepEqual(log.get('j1'), []);
    assert.deepEqual(log.get('j2'), []);
  });

  test('entries have timestamp', function (assert) {
    const log = new RunLog();
    const before = Date.now();
    log.record({ jobId: 'j1', status: 'ok' });
    const after = Date.now();

    const entry = log.get('j1')[0];
    assert.ok(entry.ts >= before && entry.ts <= after);
  });
});
