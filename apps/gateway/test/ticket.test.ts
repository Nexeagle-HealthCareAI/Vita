import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { _clearTicketsForTests, redeemTicket, verifyJwtAndIssueTicket } from '../src/ticket.js';

const SECRET = 'test-secret';

describe('ticket issuance & redemption', () => {
  beforeEach(() => _clearTicketsForTests());

  it('issues a ticket from a valid JWT and redeems it exactly once', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET);
    const ticket = verifyJwtAndIssueTicket(token, SECRET);

    const redeemed = redeemTicket(ticket);
    expect(redeemed).toEqual({
      claims: { sub: 'user-1' },
      resumeIntent: null,
      consentGiven: false,
    });

    // single-use: second redemption must fail
    expect(redeemTicket(ticket)).toBeNull();
  });

  it('carries hospitalId/hmsAccessToken through to redemption when the JWT carries them (real-staff-JWT forwarding)', () => {
    const token = jwt.sign({ sub: 'user-1', hospitalId: 'h-1', hmsAccessToken: 'real-staff-jwt' }, SECRET);
    const ticket = verifyJwtAndIssueTicket(token, SECRET);

    expect(redeemTicket(ticket)?.claims).toEqual({
      sub: 'user-1',
      hospitalId: 'h-1',
      hmsAccessToken: 'real-staff-jwt',
    });
  });

  it('redeems fine when hospitalId/hmsAccessToken are absent (backward compat -- an older/malformed ticket degrades to no staff-auth tools, not a hard failure)', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET);
    const ticket = verifyJwtAndIssueTicket(token, SECRET);

    const claims = redeemTicket(ticket)?.claims;
    expect(claims?.sub).toBe('user-1');
    expect(claims?.hospitalId).toBeUndefined();
    expect(claims?.hmsAccessToken).toBeUndefined();
  });

  it('rejects a tampered/invalid JWT', () => {
    expect(() => verifyJwtAndIssueTicket('not-a-real-jwt', SECRET)).toThrow();
  });

  it('rejects an expired or unknown ticket', () => {
    expect(redeemTicket('does-not-exist')).toBeNull();
  });

  it('carries an optional resumeIntent through issuance to redemption, opaquely', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET);
    const ticket = verifyJwtAndIssueTicket(token, SECRET, { sessionId: 's1', resumeToken: 'tok-1' });

    expect(redeemTicket(ticket)?.resumeIntent).toEqual({ sessionId: 's1', resumeToken: 'tok-1' });
  });

  it('defaults consentGiven to false when not passed, and carries true through when it is', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET);

    const withoutConsent = verifyJwtAndIssueTicket(token, SECRET);
    expect(redeemTicket(withoutConsent)?.consentGiven).toBe(false);

    const withConsent = verifyJwtAndIssueTicket(token, SECRET, undefined, true);
    expect(redeemTicket(withConsent)?.consentGiven).toBe(true);
  });
});
