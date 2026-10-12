import { config, type SourceKey } from '../config.js';
import { gauge, counter } from './metrics.js';
import { logger } from './logger.js';

type State = 'closed' | 'open' | 'half-open';

/**
 * One breaker per upstream. After N consecutive failures it opens, so requests
 * fail fast with an explicit CIRCUIT_OPEN status instead of queueing behind a
 * dead API and burning the whole request budget.
 */
class Breaker {
  private failures = 0;
  private state: State = 'closed';
  private openedAt = 0;

  constructor(
    private readonly key: string,
    private readonly now: () => number = Date.now,
  ) {}

  canRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && this.now() - this.openedAt >= config.breakerOpenMs) {
      this.state = 'half-open';
      this.report();
      return true;
    }
    return this.state === 'half-open';
  }

  onSuccess(): void {
    if (this.state !== 'closed') logger.info({ source: this.key }, 'breaker closed');
    this.failures = 0;
    this.state = 'closed';
    this.report();
  }

  onFailure(): void {
    this.failures += 1;
    if (this.failures >= config.breakerFailureThreshold && this.state !== 'open') {
      this.state = 'open';
      this.openedAt = this.now();
      counter('breaker_opened_total', { source: this.key });
      logger.warn({ source: this.key, failures: this.failures }, 'breaker opened');
    } else if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = this.now();
    }
    this.report();
  }

  private report(): void {
    gauge('breaker_state', this.state === 'closed' ? 0 : this.state === 'half-open' ? 1 : 2, {
      source: this.key,
    });
  }

  reset(): void {
    this.failures = 0;
    this.state = 'closed';
    this.openedAt = 0;
  }
}

const breakers = new Map<string, Breaker>();

export const breakerFor = (key: SourceKey | string): Breaker => {
  let b = breakers.get(key);
  if (!b) {
    b = new Breaker(key);
    breakers.set(key, b);
  }
  return b;
};

/** Test-only. */
export const __resetBreakers = (): void => {
  for (const b of breakers.values()) b.reset();
};
