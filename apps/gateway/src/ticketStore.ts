// Named `Redis` export, not the default -- same import style apps/orchestrator/src/index.ts
// already uses, and the one that actually works under this repo's NodeNext resolution.
import { Redis as IORedis, type Redis } from 'ioredis';
import type { RedeemedTicket } from './ticket.js';

/** What actually gets stored per ticket. `expiresAt` is retained even in the Redis impl
 * (where the key's own TTL already handles expiry) so both impls validate identically and
 * a clock-skewed read can't resurrect a stale ticket. */
export interface StoredTicket extends RedeemedTicket {
  expiresAt: number;
}

/**
 * Where single-use WS tickets live between issuance (POST /session/ticket) and redemption
 * (the WS upgrade's preValidation hook).
 *
 * The whole reason this is an interface: with more than one gateway instance behind a
 * plain load balancer, the ticket POST may land on instance A while the upgrade lands on
 * instance B. An in-memory Map means B has never heard of the ticket and rejects every
 * such connection -- total breakage, not degradation. A shared Redis store fixes that.
 */
export interface TicketStore {
  put(ticket: string, record: StoredTicket, ttlMs: number): Promise<void>;
  /** Atomically get-and-delete: returns the record exactly once, then never again.
   * Returns null for unknown, already-taken, or expired. */
  take(ticket: string): Promise<StoredTicket | null>;
  /** Liveness probe for /healthz. Resolves false rather than throwing. */
  healthy(): Promise<boolean>;
}

/** Today's exact behavior, unchanged -- the default whenever GATEWAY_TICKET_REDIS_URL is
 * unset, which is every environment until someone deliberately turns Redis on. */
export class InMemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, StoredTicket>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(sweepIntervalMs: number) {
    // Proactive expiry sweep -- take() only ever cleans up the ONE ticket someone
    // actually attempts to redeem, so a ticket fetched and never redeemed (client crash,
    // blocked WS, or a bot merely probing the endpoint with a valid JWT) would otherwise
    // sit in memory forever. Lives here rather than at module scope so it doesn't run
    // pointlessly against an always-empty Map when the Redis store is selected.
    // .unref() so this alone never keeps the process alive.
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  async put(ticket: string, record: StoredTicket): Promise<void> {
    this.tickets.set(ticket, record);
  }

  async take(ticket: string): Promise<StoredTicket | null> {
    const record = this.tickets.get(ticket);
    if (!record) return null;
    this.tickets.delete(ticket); // single-use, whether or not it turns out to be expired
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  async healthy(): Promise<boolean> {
    return true; // nothing external to be unhealthy about
  }

  sweep(): void {
    const now = Date.now();
    for (const [ticket, record] of this.tickets) {
      if (now > record.expiresAt) this.tickets.delete(ticket);
    }
  }

  get size(): number {
    return this.tickets.size;
  }

  clear(): void {
    this.tickets.clear();
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }
}

/**
 * Shared store so any instance can redeem a ticket any other instance issued.
 *
 * Single-use is enforced by GETDEL -- one atomic round trip, so two instances racing the
 * same ticket can't both win (which a GET-then-DEL pair would allow). Expiry is the key's
 * own TTL, with the stored expiresAt re-checked on read as a belt-and-braces guard.
 */
export class RedisTicketStore implements TicketStore {
  constructor(private readonly redis: Redis) {}

  async put(ticket: string, record: StoredTicket, ttlMs: number): Promise<void> {
    await this.redis.set(key(ticket), JSON.stringify(record), 'PX', Math.max(1, ttlMs));
  }

  async take(ticket: string): Promise<StoredTicket | null> {
    const raw = await this.redis.getdel(key(ticket));
    if (!raw) return null;
    const record = JSON.parse(raw) as StoredTicket;
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}

function key(ticket: string): string {
  return `vita:ticket:${ticket}`;
}

/**
 * Both options are load-bearing:
 * - `enableOfflineQueue: false` -- without it, commands QUEUE during an outage until the
 *   connect timeout, so the ticket endpoint hangs instead of failing fast. Failing fast is
 *   strictly better here: the SDK's fetchTicket throws on non-2xx and reconnects with
 *   backoff, whereas a hang stalls the caller with no signal.
 * - the 'error' listener -- ioredis is an EventEmitter, and an unhandled 'error' event
 *   throws, which would kill the whole gateway process on any transient Redis blip.
 */
export function createTicketRedis(url: string, log?: (err: unknown) => void): Redis {
  const client = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  client.on('error', (err: unknown) => log?.(err));
  return client;
}
