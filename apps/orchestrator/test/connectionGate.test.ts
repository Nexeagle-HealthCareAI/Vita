import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionOpenGate } from '../src/connectionGate.js';

describe('ConnectionOpenGate', () => {
  let gate: ConnectionOpenGate | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    gate?.stop();
    vi.useRealTimers();
  });

  it('acquire() resolves immediately while tokens remain in the bucket', async () => {
    gate = new ConnectionOpenGate(2, 1000);
    await expect(gate.acquire(100)).resolves.toBeUndefined();
    await expect(gate.acquire(100)).resolves.toBeUndefined();
  });

  it('acquire() queues once capacity is exhausted, and resolves once the next refill tick frees a token', async () => {
    gate = new ConnectionOpenGate(1, 100);
    await gate.acquire(1000); // drains the single token

    const pending = gate.acquire(1000);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false); // refill hasn't ticked yet

    await vi.advanceTimersByTimeAsync(60); // crosses the 100ms refill boundary
    await pending;
    expect(resolved).toBe(true);
  });

  it('acquire() rejects once maxWaitMs elapses without a free token, independent of the refill interval', async () => {
    gate = new ConnectionOpenGate(1, 10_000); // refill far slower than maxWaitMs below
    await gate.acquire(1000);

    const pending = gate.acquire(200);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it('refill never grows the bucket past its configured capacity', async () => {
    gate = new ConnectionOpenGate(2, 50);
    // Never drained -- if refill over-fills past capacity, a 3rd immediate acquire
    // would wrongly resolve instantly instead of queueing.
    await vi.advanceTimersByTimeAsync(500); // many refill ticks while already full
    await gate.acquire(10);
    await gate.acquire(10);

    const third = gate.acquire(1000);
    let resolved = false;
    void third.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false); // only 2 tokens were ever available, exactly capacity

    await vi.advanceTimersByTimeAsync(60);
    await third;
  });

  it('stop() halts refilling -- a waiter queued before stop() can only ever time out via its own maxWaitMs afterward', async () => {
    gate = new ConnectionOpenGate(1, 50);
    await gate.acquire(10); // drains the token

    const pending = gate.acquire(500);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    gate.stop(); // refill interval cleared -- nothing can resolve this waiter now
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });
});
