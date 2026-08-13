import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

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
});
