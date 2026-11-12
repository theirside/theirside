/** Fixed-capacity ring buffer. Pushing into a full buffer drops the oldest item. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private size = 0;
  /** Items dropped because the buffer was full (monotonic). */
  dropped = 0;

  constructor(readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(item: T): void {
    const tail = (this.head + this.size) % this.capacity;
    this.items[tail] = item;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
    }
  }

  /** Remove and return up to n oldest items. */
  take(n: number): T[] {
    const count = Math.min(n, this.size);
    const out = new Array<T>(count);
    for (let i = 0; i < count; i++) {
      const idx = (this.head + i) % this.capacity;
      out[i] = this.items[idx] as T;
      this.items[idx] = undefined;
    }
    this.head = (this.head + count) % this.capacity;
    this.size -= count;
    return out;
  }

  /**
   * Remove and return up to n of the oldest items for which `ready` is true; the
   * others stay queued in their order (expected outcomes: 4xx answers held a few
   * seconds for a `markExpected`).
   */
  takeWhere(n: number, ready: (item: T) => boolean): T[] {
    const all = this.take(this.size);
    this.head = 0;
    const out: T[] = [];
    for (const x of all) {
      if (out.length < n && ready(x)) out.push(x);
      else this.push(x);
    }
    return out;
  }

  /** Remove every item matching pred (keeps order). Returns how many were removed. */
  discard(pred: (item: T) => boolean): number {
    const all = this.take(this.size);
    this.head = 0;
    let removed = 0;
    for (const x of all) {
      if (pred(x)) removed++;
      else this.push(x);
    }
    return removed;
  }
}
