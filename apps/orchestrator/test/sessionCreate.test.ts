import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { buildServer } from '../src/index.js';
import { mockGroq, mockSarvam, mockHms } from './helpers.js';

function app() {
  const redis = new RedisMock();
  return buildServer(redis, { groq: mockGroq([]), sarvam: mockSarvam(), hms: mockHms() });
}

describe('POST /session — DPDPA consent gate (docs/BUILD_GUIDE.md §6)', () => {
  it('consentGiven: true creates the session and audits a consent_given/success line', async () => {
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await app().inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-1', userId: 'user-1', role: 'ROLE_RECEPTIONIST', consentGiven: true },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { sessionId: string };
    expect(body.sessionId).toBe('sess-1');

    const auditLines = auditSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(auditLines).toContainEqual(
      expect.objectContaining({ type: 'AUDIT', sessionId: 'sess-1', action: 'consent_given', outcome: 'success' }),
    );
    auditSpy.mockRestore();
  });

  it('missing consentGiven is rejected with 400, audits consent_missing/denied, and never creates a session', async () => {
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await app().inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-2', userId: 'user-1', role: 'ROLE_RECEPTIONIST' },
    });

    expect(res.statusCode).toBe(400);

    const auditLines = auditSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(auditLines).toContainEqual(
      expect.objectContaining({ type: 'AUDIT', sessionId: 'sess-2', action: 'consent_missing', outcome: 'denied' }),
    );
    expect(auditLines).not.toContainEqual(expect.objectContaining({ action: 'session_created' }));
    auditSpy.mockRestore();
  });

  it('consentGiven: false is rejected the same as omitting it entirely', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-3', userId: 'user-1', role: 'ROLE_RECEPTIONIST', consentGiven: false },
    });

    expect(res.statusCode).toBe(400);
  });
});
