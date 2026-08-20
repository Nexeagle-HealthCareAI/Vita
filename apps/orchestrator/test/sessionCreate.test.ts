import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { buildServer } from '../src/index.js';
import { mockGroq, mockStt, mockTts, mockHms } from './helpers.js';

function app(hms = mockHms()) {
  const redis = new RedisMock();
  return { app: buildServer(redis, { brain: mockGroq([]), stt: mockStt(), tts: mockTts(), hms }), hms };
}

describe('POST /session — DPDPA consent gate (docs/BUILD_GUIDE.md §6)', () => {
  it('consentGiven: true creates the session and audits a consent_given/success line', async () => {
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await app().app.inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-1', userId: 'user-1', consentGiven: true },
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

    const res = await app().app.inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-2', userId: 'user-1' },
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
    const res = await app().app.inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-3', userId: 'user-1', consentGiven: false },
    });

    expect(res.statusCode).toBe(400);
  });

  it('hospitalId/hmsAccessToken (real-staff-JWT forwarding) in the request body are persisted on the created session', async () => {
    const res = await app().app.inject({
      method: 'POST',
      url: '/session',
      payload: {
        sessionId: 'sess-4',
        userId: 'user-1',
        consentGiven: true,
        hospitalId: 'h-1',
        hmsAccessToken: 'real-staff-jwt',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { hospitalId?: string; hmsAccessToken?: string };
    expect(body.hospitalId).toBe('h-1');
    expect(body.hmsAccessToken).toBe('real-staff-jwt');
  });
});

describe('POST /session — real permissions resolved from easyHMSAPI (rbac.ts derives from GET user/permissions)', () => {
  it('a session with hmsAccessToken resolves and stores the real permission set + derived persona', async () => {
    const hms = mockHms();
    hms.getUserPermissions = vi.fn().mockResolvedValue({ permissionKeys: ['doc_board', 'ipd'], hospitalId: 'h-default' });
    const { app: server } = app(hms);

    const res = await server.inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-5', userId: 'user-1', consentGiven: true, hospitalId: 'h-1', hmsAccessToken: 'real-staff-jwt' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { permissions: string[]; persona: string; hospitalId?: string };
    expect(hms.getUserPermissions).toHaveBeenCalledWith('user-1', 'real-staff-jwt');
    expect(body.permissions).toEqual(['doc_board', 'ipd']);
    expect(body.persona).toBe('ROLE_DOCTOR');
    // hospitalId on the session stays the ticket-forwarded value, NOT the permissions
    // endpoint's default hospital (h-default) -- see permissions.ts's own doc comment.
    expect(body.hospitalId).toBe('h-1');
  });

  it('a session with no hmsAccessToken never calls getUserPermissions and resolves permissions: [] (deny-by-default)', async () => {
    const hms = mockHms();
    const { app: server } = app(hms);

    const res = await server.inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-6', userId: 'user-1', consentGiven: true },
    });

    expect(res.statusCode).toBe(200);
    expect(hms.getUserPermissions).not.toHaveBeenCalled();
    const body = JSON.parse(res.body) as { permissions: string[]; persona: string };
    expect(body.permissions).toEqual([]);
    expect(body.persona).toBe('ROLE_RECEPTIONIST');
  });

  it('a failed permissions resolve still creates the session with permissions: [] -- never blocks session creation', async () => {
    const hms = mockHms();
    hms.getUserPermissions = vi.fn().mockRejectedValue(new Error('easyHMSAPI unreachable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app: server } = app(hms);

    const res = await server.inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-7', userId: 'user-1', consentGiven: true, hospitalId: 'h-1', hmsAccessToken: 'real-staff-jwt' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { permissions: string[] };
    expect(body.permissions).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SESSION_PERMISSIONS_RESOLVE_FAILED'));
    errorSpy.mockRestore();
  });
});
