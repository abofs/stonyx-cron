export interface HeapItem {
  nextTrigger: number;
}

export default class MinHeap<T extends HeapItem> {
  items: T[] = [];

  push(job: T): void {
    this.items.push(job);
    this.bubbleUp();
  }

  pop(): T | undefined {
    if (this.items.length <= 1) return this.items.pop();
    const top = this.items[0];
    const last = this.items.pop();
    if (last === undefined) return top;
    this.items[0] = last;
    this.bubbleDown();
    return top;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  bubbleUp(): void {
    let idx = this.items.length - 1;
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.items[idx].nextTrigger >= this.items[parentIdx].nextTrigger) break;
      [this.items[idx], this.items[parentIdx]] = [this.items[parentIdx], this.items[idx]];
      idx = parentIdx;
    }
  }

  bubbleDown(): void {
    let idx = 0;
    const length = this.items.length;

    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let swapIdx: number | null = null;

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

  remove(job: T): void {
    const idx = this.items.indexOf(job);
    if (idx === -1) return;
    const end = this.items.pop();
    if (end === undefined) return;
    if (idx < this.items.length) {
      this.items[idx] = end;
      this.bubbleUp();
      this.bubbleDown();
    }
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }
}
