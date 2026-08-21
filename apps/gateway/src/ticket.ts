import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

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

interface TicketRecord {
  claims: SessionClaims;
  expiresAt: number;
  redeemed: boolean;
  resumeIntent: ResumeIntent | null;
  consentGiven: boolean;
}

/**
 * In-memory single-use ticket store for Phase 1 (single gateway instance).
 * Once the gateway scales horizontally, swap this for Redis (SETEX + GETDEL)
 * so any gateway pod can redeem a ticket issued by another pod.
 */
const tickets = new Map<string, TicketRecord>();

const TICKET_TTL_MS = Number(process.env.TICKET_TTL_SECONDS ?? 30) * 1000;

// Proactive expiry sweep -- redeemTicket() below only ever cleans up the ONE ticket
// someone actually attempts to redeem. A client that fetches a ticket and never
// completes the WS upgrade (crash, blocked WS, retry-without-cleanup, or a bot merely
// probing this endpoint with any valid JWT) previously left that entry in memory
// forever, since nothing else ever revisits it. .unref() so this alone never keeps the
// process alive, same idiom as apps/orchestrator/src/audit.ts's retention-purge loop.
function sweepExpiredTickets(): void {
  const now = Date.now();
  for (const [ticket, record] of tickets) {
    if (now > record.expiresAt) tickets.delete(ticket);
  }
}
setInterval(sweepExpiredTickets, Math.max(TICKET_TTL_MS, 5000)).unref();

export function verifyJwtAndIssueTicket(
  bearerToken: string,
  secret: string,
  resumeIntent?: ResumeIntent,
  consentGiven = false,
): string {
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
  tickets.set(ticket, {
    claims: { sub: decoded.sub, hospitalId: decoded.hospitalId, hmsAccessToken: decoded.hmsAccessToken },
    expiresAt: Date.now() + TICKET_TTL_MS,
    redeemed: false,
    resumeIntent: resumeIntent ?? null,
    consentGiven,
  });
  return ticket;
}

export function redeemTicket(ticket: string): RedeemedTicket | null {
  const record = tickets.get(ticket);
  if (!record) return null;
  if (record.redeemed || Date.now() > record.expiresAt) {
    tickets.delete(ticket);
    return null;
  }
  record.redeemed = true;
  tickets.delete(ticket); // single-use
  return { claims: record.claims, resumeIntent: record.resumeIntent, consentGiven: record.consentGiven };
}

export function _clearTicketsForTests(): void {
  tickets.clear();
}

export function _ticketCountForTests(): number {
  return tickets.size;
}

/** Exposed so a test can exercise the sweep's logic directly against a controllable
 * clock (vi.setSystemTime), rather than depending on the real, already-scheduled
 * setInterval above -- that timer starts at module-import time, before any
 * vi.useFakeTimers() a test installs afterward could ever intercept it. */
export function _sweepExpiredTicketsForTests(): void {
  sweepExpiredTickets();
}
