import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { InMemoryTicketStore, RedisTicketStore, createTicketRedis, type TicketStore } from './ticketStore.js';

export interface SessionClaims {
  sub: string; // user id
  /** Forwarded from easyHMSWeb's own already-authenticated browser session at mint time --
   * NOT derivable from hmsAccessToken itself (easyHMSAPI's own JWT carries no hospitalId
   * claim; membership is resolved server-side per-request there). Optional so an
   * older/malformed ticket degrades to "no staff-auth tools this session," not a hard
   * failure -- see apps/orchestrator/src/tools.ts's StaffAuthUnavailableError. */
  hospitalId?: string;
  /** The real staff member's own easyHMSAPI bearer JWT, carried as opaque cargo -- this
   * gateway never re-verifies it (no access to easyHMSAPI's own signing key) and Vita never
   * mints a separate identity of its own. Relayed as-is when calling easyHMSAPI's
   * staff-only endpoints on that person's behalf (see packages/mcp-1hms/src/hmsClient.ts's
   * StaffAuthContext). */
  hmsAccessToken?: string;
}

/** A caller's request to reattach to an existing orchestrator session instead of starting
 * a fresh one. Opaque to this file -- ticket.ts has no orchestrator/Redis access and makes
 * no attempt to validate it; it's pure passthrough from ticket issuance to redemption. Real
 * validation happens exactly once, at the orchestrator's POST /session/:id/resume route. */
export interface ResumeIntent {
  sessionId: string;
  resumeToken: string;
}

export interface RedeemedTicket {
  claims: SessionClaims;
  resumeIntent: ResumeIntent | null;
  consentGiven: boolean;
}

const TICKET_TTL_MS = Number(process.env.TICKET_TTL_SECONDS ?? 30) * 1000;

/**
 * Lazily-selected backing store, mirroring apps/orchestrator/src/audit.ts's optional-
 * dependency pattern (module-level nullable singleton + env-keyed getter + a `_`-prefixed
 * test override seam).
 *
 * WHERE THE ANALOGY BREAKS, deliberately: audit.ts degrades to stdout because the durable
 * audit store is genuinely optional. Tickets are NOT. If GATEWAY_TICKET_REDIS_URL is set
 * and Redis is unreachable, this must FAIL LOUD (503 on issue, 401 on redeem) rather than
 * silently falling back to in-memory -- a silent fallback would reintroduce exactly the
 * cross-instance breakage the Redis store exists to fix, while looking healthy.
 *
 * Keyed on GATEWAY_TICKET_REDIS_URL and deliberately NOT on REDIS_URL: REDIS_URL is
 * already set in this gateway's environment in every deployment (deploy.yml writes it;
 * docker-compose gives the gateway `env_file: .env`), so keying on that would flip
 * production to Redis on the next deploy with nobody choosing it.
 */
let store: TicketStore | null = null;

function getStore(): TicketStore {
  if (store) return store;
  const url = process.env.GATEWAY_TICKET_REDIS_URL;
  store = url
    ? new RedisTicketStore(createTicketRedis(url, (err) => console.error(JSON.stringify({ type: 'TICKET_REDIS_ERROR', error: err instanceof Error ? err.message : String(err) }))))
    : new InMemoryTicketStore(Math.max(TICKET_TTL_MS, 5000));
  return store;
}

/** Distinguishes "the ticket store is down" (503 -- retryable, not the caller's fault)
 * from "this JWT is bad" (401), which the route would otherwise conflate into a
 * misleading 401 that tells a healthy client its credentials are wrong. */
export class TicketStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`ticket store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TicketStoreUnavailableError';
  }
}

export async function verifyJwtAndIssueTicket(
  bearerToken: string,
  secret: string,
  resumeIntent?: ResumeIntent,
  consentGiven = false,
): Promise<string> {
  // Identity (and, when present, hospitalId/hmsAccessToken) come ONLY from the verified
  // JWT — never from anything the client sends alongside it. This is what closes the
  // privilege-escalation gap from the v1.0 draft, where `role` was a client-supplied WS
  // query param (role/persona is no longer part of this contract at all -- it's now
  // derived server-side, orchestrator-side, from real resolved permissions -- see
  // apps/orchestrator/src/rbac.ts's Persona doc comment).
  // algorithms pinned explicitly rather than relying on jsonwebtoken's own key-type
  // inference (which does already correctly reject `alg: none` for a plain string
  // secret) -- defense-in-depth that stays correct even if this code is ever refactored
  // to accept an asymmetric key.
  const decoded = jwt.verify(bearerToken, secret, { algorithms: ['HS256'] }) as SessionClaims;
  const ticket = randomUUID();
  // Rethrown as a distinct type (=> 503 at the route, never 401): the JWT was fine, the
  // store isn't. Deliberately NOT swallowed with an in-memory fallback -- see getStore().
  try {
    await getStore().put(
      ticket,
      {
        claims: { sub: decoded.sub, hospitalId: decoded.hospitalId, hmsAccessToken: decoded.hmsAccessToken },
        expiresAt: Date.now() + TICKET_TTL_MS,
        resumeIntent: resumeIntent ?? null,
        consentGiven,
      },
      TICKET_TTL_MS,
    );
  } catch (err) {
    throw new TicketStoreUnavailableError(err);
  }
  return ticket;
}

export async function redeemTicket(ticket: string): Promise<RedeemedTicket | null> {
  try {
    const record = await getStore().take(ticket);
    if (!record) return null;
    return { claims: record.claims, resumeIntent: record.resumeIntent, consentGiven: record.consentGiven };
  } catch (err) {
    // An unreachable store means we cannot prove this ticket is valid and unused, so the
    // only safe answer is "no" -- which the caller turns into a 401. Never fall back to a
    // local store here (see getStore()).
    console.error(JSON.stringify({ type: 'TICKET_REDEEM_FAILED', error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

/** Liveness of the ticket store, surfaced by /healthz -- an instance whose ticket Redis
 * is unreachable fails 100% of connections and must not report itself healthy. */
export async function ticketStoreHealthy(): Promise<boolean> {
  return getStore().healthy();
}

export async function _clearTicketsForTests(): Promise<void> {
  const s = getStore();
  if (s instanceof InMemoryTicketStore) s.clear();
}

export async function _ticketCountForTests(): Promise<number> {
  const s = getStore();
  return s instanceof InMemoryTicketStore ? s.size : 0;
}

/** Exposed so a test can exercise the sweep's logic directly against a controllable
 * clock (vi.setSystemTime), rather than depending on the real, already-scheduled
 * setInterval -- that timer starts when the store is first constructed, before any
 * vi.useFakeTimers() a test installs afterward could ever intercept it. */
export function _sweepExpiredTicketsForTests(): void {
  const s = getStore();
  if (s instanceof InMemoryTicketStore) s.sweep();
}

/** Override seam, same naming precedent as audit.ts's _setAuditStoreForTests. Pass null
 * to force re-selection from the environment on the next call. */
export function _setTicketStoreForTests(override: TicketStore | null): void {
  if (store instanceof InMemoryTicketStore) store.stop();
  store = override;
}
