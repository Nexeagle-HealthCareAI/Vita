import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { buildServer } from '../src/index.js';
import { mockGroq, mockStt, mockTts, mockHms } from './helpers.js';

function app(redis: Redis) {
  return buildServer(redis, { brain: mockGroq([]), stt: mockStt(), tts: mockTts(), hms: mockHms() });
}

describe('GET /healthz', () => {
  it('returns ok when Redis is reachable', async () => {
    const res = await app(new RedisMock()).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when Redis is unreachable -- previously an unconditional {status:"ok"} regardless', async () => {
    const brokenRedis = { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as unknown as Redis;
    const res = await app(brokenRedis).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', redis: 'unreachable' });
  });
});
