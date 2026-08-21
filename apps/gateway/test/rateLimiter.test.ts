import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/rateLimiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    limiter?.stop();
    vi.useRealTimers();
  });

  it('tryConsume() succeeds while tokens remain in the bucket', () => {
    limiter = new RateLimiter(2, 1000);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
  });

  it('tryConsume() fails once capacity is exhausted -- no queueing, an immediate false', () => {
    limiter = new RateLimiter(1, 1000);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('refill frees a token after the configured interval elapses', () => {
    limiter = new RateLimiter(1, 100);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(100);

    expect(limiter.tryConsume()).toBe(true);
  });

  it('refill never grows the bucket past its configured capacity', () => {
    limiter = new RateLimiter(2, 50);
    vi.advanceTimersByTime(500); // many refill ticks while already full

    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false); // only ever 2 tokens, exactly capacity
  });

  it('stop() halts refilling -- an exhausted bucket stays exhausted', () => {
    limiter = new RateLimiter(1, 50);
    expect(limiter.tryConsume()).toBe(true);
    limiter.stop();

    vi.advanceTimersByTime(500);

    expect(limiter.tryConsume()).toBe(false);
  });
});
