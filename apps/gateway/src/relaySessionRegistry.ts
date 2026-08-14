import type { ConnectionRelay } from './relay.js';

/**
 * Tracks at most one live ConnectionRelay per orchestrator sessionId **on this gateway
 * process only** -- Phase 1, single-instance scope, identical to ticket.ts's already-
 * accepted in-memory ticket store limitation. Cross-instance coordination (e.g. a resume
 * landing on a different pod than the one holding the stale connection) is explicitly out
 * of scope; see the SESSION_RESUME plan's Concurrency section.
 */
export class RelaySessionRegistry {
  private readonly live = new Map<string, ConnectionRelay>();

  /** Force-closes and evicts whatever relay is currently registered for sessionId, if any
   * -- no-op if nothing is registered (the common case). relay.close() now also severs the
   * stale socket (RelayDeps.close), so an evicted connection doesn't linger as a zombie
   * that's technically open but can never do anything. */
  evict(sessionId: string): void {
    const existing = this.live.get(sessionId);
    if (!existing) return;
    this.live.delete(sessionId);
    existing.close();
  }

  register(sessionId: string, relay: ConnectionRelay): void {
    this.live.set(sessionId, relay);
  }

  /** Identity-checked delete: only removes the entry if it still points at THIS exact
   * relay instance. Protects the registry's own bookkeeping if two connections both win a
   * resume against a not-yet-rotated stale token (SessionStore.resume()'s check-then-write
   * isn't atomic) -- whichever's register() lands second must not have its entry deleted
   * by the loser's later close(). */
  unregister(sessionId: string, relay: ConnectionRelay): void {
    if (this.live.get(sessionId) === relay) {
      this.live.delete(sessionId);
    }
  }
}
