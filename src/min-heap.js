export default class MinHeap {
  constructor() {
    this.items = [];
  }

  push(job) {
    this.items.push(job);
    this.bubbleUp();
  }

  pop() {
    if (this.items.length === 1) return this.items.pop();
    const top = this.items[0];
    this.items[0] = this.items.pop();
    this.bubbleDown();
    return top;
  }

  peek() {
    return this.items[0];
  }

  bubbleUp() {
    let idx = this.items.length - 1;
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.items[idx].nextTrigger >= this.items[parentIdx].nextTrigger) break;
      [this.items[idx], this.items[parentIdx]] = [this.items[parentIdx], this.items[idx]];
      idx = parentIdx;
    }
  }

  bubbleDown() {
    let idx = 0;
    const length = this.items.length;

    while (true) {
      let leftIdx = 2 * idx + 1;
      let rightIdx = 2 * idx + 2;
      let swapIdx = null;

      if (leftIdx < length && this.items[leftIdx].nextTrigger < this.items[idx].nextTrigger) {
        swapIdx = leftIdx;
      }
      if (
        rightIdx < length &&
        this.items[rightIdx].nextTrigger < (
          swapIdx === null ? this.items[idx].nextTrigger : this.items[leftIdx].nextTrigger
        )
      ) {
        swapIdx = rightIdx;
      }
      if (swapIdx === null) break;
      [this.items[idx], this.items[swapIdx]] = [this.items[swapIdx], this.items[idx]];
      idx = swapIdx;
    }
  }

  remove(job) {
    const idx = this.items.indexOf(job);
    if (idx === -1) return;
    const end = this.items.pop();
    if (idx < this.items.length) {
      this.items[idx] = end;
      this.bubbleUp();
      this.bubbleDown();
    }
  }

  isEmpty() {
    return this.items.length === 0;
  }
}
