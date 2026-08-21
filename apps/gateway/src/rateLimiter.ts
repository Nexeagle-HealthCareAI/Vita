/**
 * Global (not per-IP) token-bucket rate limiter for POST /session/ticket -- this
 * endpoint accepts any Bearer token and only verifies the JWT signature INSIDE the
 * handler, so an unauthenticated burst of requests (a bot, or a client retry loop)
 * previously had no throttling at all: zero per-IP connection cap, zero ticket-issuance
 * throttle, nothing bounding CPU spent on JWT verification or growth of the in-memory
 * ticket Map.
 *
 * Deliberately global rather than per-IP: this gateway sits behind a shared reverse
 * proxy (docker-compose.prod.yml's own comment) but ALSO publishes its port directly on
 * the host (for the deploy health check), so a per-IP scheme trusting
 * X-Forwarded-For would let any direct caller spoof an arbitrary IP and bypass it
 * entirely. A global bucket can't distinguish "one bad actor" from "many legitimate
 * callers at once," but it does bound the one thing that actually matters here --
 * protecting this process from being overwhelmed -- without a spoofable trust
 * assumption. Same token-bucket shape as apps/orchestrator/src/connectionGate.ts,
 * duplicated rather than shared since gateway and orchestrator don't share a code
 * boundary for this and the class is small.
 */
export class RateLimiter {
  private tokens: number;
  private readonly refillTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly capacity: number,
    refillMs: number,
  ) {
    this.tokens = capacity;
    // unref()'d so this interval never keeps the process alive on its own.
    this.refillTimer = setInterval(() => {
      if (this.tokens < this.capacity) this.tokens++;
    }, refillMs);
    this.refillTimer.unref();
  }

  /** Non-blocking: true and consumes a token if under budget, false (caller should
   * reject with 429) if not. No queueing -- a rate-limited caller gets a fast, clear
   * answer instead of sitting blocked on an endpoint that's supposed to be cheap. */
  tryConsume(): boolean {
    if (this.tokens <= 0) return false;
    this.tokens--;
    return true;
  }

  /** For tests / graceful shutdown -- stops the refill interval. */
  stop(): void {
    clearInterval(this.refillTimer);
  }
}
