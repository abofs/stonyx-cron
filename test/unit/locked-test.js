import QUnit from 'qunit';
const { module, test } = QUnit;
import { locked, resetLock } from '../../src/locked.js';

module('locked', function (hooks) {
  hooks.afterEach(function () {
    resetLock();
  });

  test('executes function and returns result', async function (assert) {
    const result = await locked(() => 42);
    assert.strictEqual(result, 42);
  });

  test('serializes concurrent calls', async function (assert) {
    const order = [];

    const p1 = locked(async () => {
      order.push('a-start');
      await new Promise(r => setTimeout(r, 50));
      order.push('a-end');
    });

    const p2 = locked(async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await Promise.all([p1, p2]);

    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('releases lock even on error', async function (assert) {
    try {
      await locked(() => { throw new Error('boom'); });
    } catch { /* expected */ }

    const result = await locked(() => 'recovered');
    assert.strictEqual(result, 'recovered');
  });

  test('handles async functions', async function (assert) {
    const result = await locked(async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'async result';
    });
    assert.strictEqual(result, 'async result');
  });
});
