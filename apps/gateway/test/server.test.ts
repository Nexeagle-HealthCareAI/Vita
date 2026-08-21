import { afterEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { buildServer, extractTicketProtocol } from '../src/index.js';
import { redeemTicket } from '../src/ticket.js';
import { OrchestratorClient } from '../src/orchestratorClient.js';
import { RateLimiter } from '../src/rateLimiter.js';

function fakeHealthyOrchestrator(healthy = true): OrchestratorClient {
  const client = Object.create(OrchestratorClient.prototype) as OrchestratorClient;
  client.healthz = vi.fn().mockResolvedValue(healthy);
  return client;
}

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
  it('GET /healthz returns ok when the orchestrator is reachable', async () => {
    const app = buildServer({ orchestrator: fakeHealthyOrchestrator(true) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /healthz returns 503 when the orchestrator is unreachable -- a real outage should not report healthy', async () => {
    const app = buildServer({ orchestrator: fakeHealthyOrchestrator(false) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
  });

  it('POST /session/ticket without a bearer token is rejected', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'POST', url: '/session/ticket' });
    expect(res.statusCode).toBe(401);
  });

  describe('POST /session/ticket rate limiting', () => {
    it('returns 429 once the bucket is exhausted, before ever checking the bearer token', async () => {
      const limiter = new RateLimiter(2, 60_000); // capacity 2, no realistic refill within this test
      const app = buildServer({ ticketRateLimiter: limiter });

      const first = await app.inject({ method: 'POST', url: '/session/ticket' }); // no auth header -- would 401 if it got that far
      const second = await app.inject({ method: 'POST', url: '/session/ticket' });
      const third = await app.inject({ method: 'POST', url: '/session/ticket' });

      expect(first.statusCode).toBe(401); // consumed a token, then rejected for the real reason (no auth)
      expect(second.statusCode).toBe(401);
      expect(third.statusCode).toBe(429); // bucket exhausted -- rejected before the auth check ever runs
      limiter.stop();
    });

    it('a valid request still succeeds when under budget', async () => {
      const limiter = new RateLimiter(5, 60_000);
      const app = buildServer({ ticketRateLimiter: limiter });
      const token = jwt.sign({ sub: 'user-1' }, JWT_SECRET);

      const res = await app.inject({
        method: 'POST',
        url: '/session/ticket',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      limiter.stop();
    });
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
      const token = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
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
      const token = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
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
      const token = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
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
      const token = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
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
      { sub: 'user-1', hospitalId: 'h-1', hmsAccessToken: 'real-staff-jwt' },
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
      hospitalId: 'h-1',
      hmsAccessToken: 'real-staff-jwt',
    });
  });

  describe('GET /v1/stream ticket rejection happens BEFORE the WS upgrade', () => {
    // Redemption moved into a preValidation hook so the socket handler can stay
    // synchronous (an async handler would drop frames arriving before
    // socket.on('message') is registered). The observable consequence is that a bad
    // ticket is now a plain HTTP 401 -- the upgrade never happens -- rather than an
    // accepted upgrade followed by close(4001).
    it('an absent ticket subprotocol is rejected with 401, not an upgrade', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stream',
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('an unknown/expired ticket is rejected with 401, not an upgrade', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stream',
        headers: {
          connection: 'upgrade',
          upgrade: 'websocket',
          'sec-websocket-protocol': 'vita-ticket.never-issued',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
