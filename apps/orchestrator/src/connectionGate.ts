/**
 * Simple token-bucket gate around opening new Sarvam realtime WS connections.
 *
 * Sarvam's documented rate limiter is burst-sensitive, not a static concurrency
 * ceiling: "the limiter reacts to how fast new connections are opened, not how many
 * are held open at once" (docs.sarvam.ai/api/getting-started/ratelimits, fetched
 * during planning). A shift-change-style burst of call-starts at a reception desk
 * could trip that even under the nominal per-plan limit. This gate staggers new
 * connection *attempts*, not concurrent calls in general -- it's released the moment
 * SarvamRealtimeSession.connect() is called, not held for the call's duration.
 */
export class ConnectionOpenGate {
  private tokens: number;
  private readonly waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  private readonly refillTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly capacity: number,
    refillMs: number,
  ) {
    this.tokens = capacity;
    // unref()'d so this interval never keeps the process alive on its own (relevant for
    // graceful shutdown and for tests that don't explicitly call stop()).
    this.refillTimer = setInterval(() => this.refill(), refillMs);
    this.refillTimer.unref();
  }

  /** Resolves once a token is available; rejects if that takes longer than maxWaitMs.
   * A rejection is treated identically to a Sarvam connect failure by the caller --
   * degrade this call to the batch fallback, don't retry. */
  acquire(maxWaitMs: number): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error('ConnectionOpenGate: acquire timed out waiting for a token'));
      }, maxWaitMs);
      this.waiters.push({ resolve, timer });
    });
  }

  private refill(): void {
    if (this.tokens < this.capacity) this.tokens++;
    while (this.tokens > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      this.tokens--;
      waiter.resolve();
    }
  }

  /** For tests / graceful shutdown -- stops the refill interval. */
  stop(): void {
    clearInterval(this.refillTimer);
  }
}
