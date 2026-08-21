import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { _clearTicketsForTests, _sweepExpiredTicketsForTests, _ticketCountForTests, redeemTicket, verifyJwtAndIssueTicket } from '../src/ticket.js';

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

  it('rejects a JWT signed with a different algorithm than the pinned HS256', () => {
    // A plain-string secret already makes jsonwebtoken infer an HMAC algorithm and
    // reject `alg: none`, but the explicit allow-list is defense-in-depth that should
    // stay correct even if this code is ever refactored -- confirm it's actually wired
    // in, not just implied by the library's own default inference.
    const noneAlgToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.`;
    expect(() => verifyJwtAndIssueTicket(noneAlgToken, SECRET)).toThrow();
  });

  describe('proactive expiry sweep (a ticket nothing ever tries to redeem)', () => {
    afterEach(() => vi.useRealTimers());

    it('sweepExpiredTickets removes an unredeemed-but-expired ticket, not just lazily on a redemption attempt', () => {
      const token = jwt.sign({ sub: 'user-1' }, SECRET);
      verifyJwtAndIssueTicket(token, SECRET); // never redeemed
      expect(_ticketCountForTests()).toBe(1);

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 60_000); // past TICKET_TTL_SECONDS's 30s default
      _sweepExpiredTicketsForTests();

      expect(_ticketCountForTests()).toBe(0);
    });

    it('leaves a not-yet-expired ticket alone', () => {
      const token = jwt.sign({ sub: 'user-1' }, SECRET);
      verifyJwtAndIssueTicket(token, SECRET);

      _sweepExpiredTicketsForTests();

      expect(_ticketCountForTests()).toBe(1);
    });
  });
});
