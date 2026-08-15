import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export interface SessionClaims {
  sub: string; // user id
  role: 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';
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

export function verifyJwtAndIssueTicket(
  bearerToken: string,
  secret: string,
  resumeIntent?: ResumeIntent,
  consentGiven = false,
): string {
  // Role and identity come ONLY from the verified JWT — never from anything
  // the client sends alongside it. This is what closes the privilege-
  // escalation gap from the v1.0 draft, where `role` was a client-supplied
  // WS query param.
  const decoded = jwt.verify(bearerToken, secret) as SessionClaims;
  const ticket = randomUUID();
  tickets.set(ticket, {
    claims: { sub: decoded.sub, role: decoded.role },
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
