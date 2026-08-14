import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { _clearTicketsForTests, redeemTicket, verifyJwtAndIssueTicket } from '../src/ticket.js';

const SECRET = 'test-secret';

describe('ticket issuance & redemption', () => {
  beforeEach(() => _clearTicketsForTests());

  it('issues a ticket from a valid JWT and redeems it exactly once', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, SECRET);
    const ticket = verifyJwtAndIssueTicket(token, SECRET);

    const redeemed = redeemTicket(ticket);
    expect(redeemed).toEqual({ claims: { sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, resumeIntent: null });

    // single-use: second redemption must fail
    expect(redeemTicket(ticket)).toBeNull();
  });

  it('rejects a tampered/invalid JWT', () => {
    expect(() => verifyJwtAndIssueTicket('not-a-real-jwt', SECRET)).toThrow();
  });

  it('derives role from the JWT claims, not from anything client-supplied', () => {
    // Nothing in verifyJwtAndIssueTicket's signature accepts a client-asserted
    // role at all — this test documents that invariant so a future refactor
    // can't accidentally reintroduce the v1.0 privilege-escalation path.
    const token = jwt.sign({ sub: 'user-2', role: 'ROLE_DOCTOR' }, SECRET);
    const ticket = verifyJwtAndIssueTicket(token, SECRET);
    expect(redeemTicket(ticket)?.claims.role).toBe('ROLE_DOCTOR');
  });

  it('rejects an expired or unknown ticket', () => {
    expect(redeemTicket('does-not-exist')).toBeNull();
  });

  it('carries an optional resumeIntent through issuance to redemption, opaquely', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, SECRET);
    const ticket = verifyJwtAndIssueTicket(token, SECRET, { sessionId: 's1', resumeToken: 'tok-1' });

    expect(redeemTicket(ticket)?.resumeIntent).toEqual({ sessionId: 's1', resumeToken: 'tok-1' });
  });
});
