import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export interface SessionClaims {
  sub: string; // user id
  role: 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';
}

interface TicketRecord {
  claims: SessionClaims;
  expiresAt: number;
  redeemed: boolean;
}

/**
 * In-memory single-use ticket store for Phase 1 (single gateway instance).
 * Once the gateway scales horizontally, swap this for Redis (SETEX + GETDEL)
 * so any gateway pod can redeem a ticket issued by another pod.
 */
const tickets = new Map<string, TicketRecord>();

const TICKET_TTL_MS = Number(process.env.TICKET_TTL_SECONDS ?? 30) * 1000;

export function verifyJwtAndIssueTicket(bearerToken: string, secret: string): string {
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
  });
  return ticket;
}

export function redeemTicket(ticket: string): SessionClaims | null {
  const record = tickets.get(ticket);
  if (!record) return null;
  if (record.redeemed || Date.now() > record.expiresAt) {
    tickets.delete(ticket);
    return null;
  }
  record.redeemed = true;
  tickets.delete(ticket); // single-use
  return record.claims;
}

export function _clearTicketsForTests(): void {
  tickets.clear();
}
