import { afterEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { buildServer, extractTicketProtocol } from '../src/index.js';
import { redeemTicket } from '../src/ticket.js';

// buildServer's JWT_SECRET is read once at module load from JWT_SIGNING_SECRET, defaulting
// to 'change-me' -- same convention wsRelay.integration.test.ts relies on.
const JWT_SECRET = 'change-me';

describe('gateway ticket protocol compatibility', () => {
  it('extracts Vita ticket protocols', () => {
    expect(extractTicketProtocol(['vita-ticket.test-ticket'])).toBe('test-ticket');
  });

  it('continues accepting legacy Tera ticket protocols', () => {
    expect(extractTicketProtocol(['tera-ticket.legacy-ticket'])).toBe('legacy-ticket');
  });

  it('ignores unrelated protocols', () => {
    expect(extractTicketProtocol(['audio', 'chat'])).toBeUndefined();
  });
});

describe('gateway HTTP surface', () => {
  it('GET /healthz returns ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('POST /session/ticket without a bearer token is rejected', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'POST', url: '/session/ticket' });
    expect(res.statusCode).toBe(401);
  });

  describe('CORS (web-sdk is embedded in an arbitrary host app, rarely same-origin)', () => {
    it('a preflight OPTIONS request for POST /session/ticket is allowed from any origin', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/session/ticket',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('the real POST /session/ticket response also carries the CORS header, not just the preflight', async () => {
      const app = buildServer();
      const token = jwt.sign({ sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, JWT_SECRET);
      const res = await app.inject({
        method: 'POST',
        url: '/session/ticket',
        headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:5173' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });
  });

  describe('POST /session/ticket resume passthrough', () => {
    afterEach(() => {
      delete process.env.SESSION_RESUME_ENABLED;
    });

    it('a resumeSessionId/resumeToken body round-trips into the issued ticket, opaquely', async () => {
      const app = buildServer();
      const token = jwt.sign({ sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, JWT_SECRET);
      const res = await app.inject({
        method: 'POST',
        url: '/session/ticket',
        headers: { authorization: `Bearer ${token}` },
        payload: { resumeSessionId: 's1', resumeToken: 'tok-1' },
      });

      const { ticket } = res.json() as { ticket: string };
      expect(redeemTicket(ticket)?.resumeIntent).toEqual({ sessionId: 's1', resumeToken: 'tok-1' });
    });

    it('SESSION_RESUME_ENABLED=false drops the resume pair even when the client sends it', async () => {
      process.env.SESSION_RESUME_ENABLED = 'false';
      const app = buildServer();
      const token = jwt.sign({ sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, JWT_SECRET);
      const res = await app.inject({
        method: 'POST',
        url: '/session/ticket',
        headers: { authorization: `Bearer ${token}` },
        payload: { resumeSessionId: 's1', resumeToken: 'tok-1' },
      });

      const { ticket } = res.json() as { ticket: string };
      expect(redeemTicket(ticket)?.resumeIntent).toBeNull();
    });

    it('a fresh session (no resume fields in the body) issues a ticket with a null resumeIntent', async () => {
      const app = buildServer();
      const token = jwt.sign({ sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, JWT_SECRET);
      const res = await app.inject({
        method: 'POST',
        url: '/session/ticket',
        headers: { authorization: `Bearer ${token}` },
      });

      const { ticket } = res.json() as { ticket: string };
      expect(redeemTicket(ticket)?.resumeIntent).toBeNull();
    });
  });

  it('a JWT carrying hospitalId/hmsAccessToken (real-staff-JWT forwarding) reaches redeemTicket()\'s claims end-to-end', async () => {
    const app = buildServer();
    const token = jwt.sign(
      { sub: 'user-1', role: 'ROLE_RECEPTIONIST', hospitalId: 'h-1', hmsAccessToken: 'real-staff-jwt' },
      JWT_SECRET,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/session/ticket',
      headers: { authorization: `Bearer ${token}` },
    });

    const { ticket } = res.json() as { ticket: string };
    expect(redeemTicket(ticket)?.claims).toEqual({
      sub: 'user-1',
      role: 'ROLE_RECEPTIONIST',
      hospitalId: 'h-1',
      hmsAccessToken: 'real-staff-jwt',
    });
  });
});
