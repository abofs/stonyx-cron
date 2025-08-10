import QUnit from 'qunit';
import MinHeap from '../src/min-heap.js';

const { module, test } = QUnit;

module('[Unit] MinHeap', function () {
  test('push and peek should return the smallest nextTrigger job', function (assert) {
    const heap = new MinHeap();
    const job1 = { nextTrigger: 5 };
    const job2 = { nextTrigger: 2 };
    const job3 = { nextTrigger: 8 };

    heap.push(job1);
    heap.push(job2);
    heap.push(job3);

    assert.strictEqual(heap.peek(), job2, 'Job with smallest nextTrigger is at the top');
  });

  test('pop should remove and return the smallest job', function (assert) {
    const heap = new MinHeap();
    const job1 = { nextTrigger: 5 };
    const job2 = { nextTrigger: 2 };
    const job3 = { nextTrigger: 8 };

    heap.push(job1);
    heap.push(job2);
    heap.push(job3);

    const popped = heap.pop();
    assert.strictEqual(popped, job2, 'Popped job is the smallest');
    assert.strictEqual(heap.peek(), job1, 'Next smallest job is now at the top');
  });

  test('isEmpty should correctly reflect heap state', function (assert) {
    const heap = new MinHeap();
    assert.ok(heap.isEmpty(), 'Heap is empty initially');

    heap.push({ nextTrigger: 1 });
    assert.notOk(heap.isEmpty(), 'Heap is not empty after adding a job');

    heap.pop();
    assert.ok(heap.isEmpty(), 'Heap is empty after removing last job');
  });

  test('remove should delete a specific job from the heap', function (assert) {
    const heap = new MinHeap();
    const job1 = { nextTrigger: 5 };
    const job2 = { nextTrigger: 2 };
    const job3 = { nextTrigger: 8 };

    heap.push(job1);
    heap.push(job2);
    heap.push(job3);

    heap.remove(job2);
    assert.notStrictEqual(heap.peek(), job2, 'Removed job is no longer in heap');
    assert.ok([job1, job3].includes(heap.peek()), 'Heap still has remaining jobs');
  });

  test('pop should work correctly when only one item is in heap', function (assert) {
    const heap = new MinHeap();
    const job = { nextTrigger: 1 };
    heap.push(job);

    assert.strictEqual(heap.pop(), job, 'Popped the only job in the heap');
    assert.ok(heap.isEmpty(), 'Heap is empty after popping last job');
  });

  test('pop should return undefined if heap is empty', function (assert) {
    const heap = new MinHeap();
    assert.strictEqual(heap.pop(), undefined, 'Pop returns undefined for empty heap');
  });

  test('peek should return undefined if heap is empty', function (assert) {
    const heap = new MinHeap();
    assert.strictEqual(heap.peek(), undefined, 'Peek returns undefined for empty heap');
  });
});
