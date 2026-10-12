import { config } from '../config.js';

/**
 * Per-upstream concurrency cap. Without this, one API sitting at 30s soaks the
 * shared connection pool and every other upstream slows down with it.
 */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const bulkheads = new Map<string, Semaphore>();

export const bulkheadFor = (key: string): Semaphore => {
  let s = bulkheads.get(key);
  if (!s) {
    s = new Semaphore(config.bulkheadLimit);
    bulkheads.set(key, s);
  }
  return s;
};
