import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { buildServer } from '../src/index.js';
import { mockGroq, mockStt, mockTts, mockHms } from './helpers.js';

describe('buildServer() stays synchronous with VITA_HMS_STAFF_AUTH_ENABLED=true', () => {
  afterEach(() => {
    delete process.env.VITA_HMS_STAFF_AUTH_ENABLED;
    delete process.env.HOSPITAL_ID;
    delete process.env.VITA_HMS_STAFF_LOGIN;
    delete process.env.VITA_HMS_STAFF_PASSWORD;
  });

  it('buildServer() itself never becomes a Promise -- HmsAuthClient construction must stay sync', () => {
    process.env.VITA_HMS_STAFF_AUTH_ENABLED = 'true';
    process.env.HOSPITAL_ID = 'hosp-1';
    process.env.VITA_HMS_STAFF_LOGIN = 'vita@hosp-1';
    process.env.VITA_HMS_STAFF_PASSWORD = 'super-secret';

    // clients.hms is provided (mockHms()), so index.ts's `!clients?.hms` guard means no
    // REAL HmsAuthClient is constructed here -- this test's only job is confirming
    // buildServer's own return type/timing was never made async by this feature's wiring,
    // same guarantee every other test in this suite already implicitly relies on by never
    // awaiting buildServer().
    const result = buildServer(new RedisMock(), { brain: mockGroq([]), stt: mockStt(), tts: mockTts(), hms: mockHms() });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.inject).toBe('function');
  });

  it('a normal request still succeeds end-to-end with the staff-auth env vars set', async () => {
    process.env.VITA_HMS_STAFF_AUTH_ENABLED = 'true';
    process.env.HOSPITAL_ID = 'hosp-1';
    process.env.VITA_HMS_STAFF_LOGIN = 'vita@hosp-1';
    process.env.VITA_HMS_STAFF_PASSWORD = 'super-secret';

    const app = buildServer(new RedisMock(), { brain: mockGroq([]), stt: mockStt(), tts: mockTts(), hms: mockHms() });
    const res = await app.inject({
      method: 'POST',
      url: '/session',
      payload: { sessionId: 'sess-1', userId: 'user-1', role: 'ROLE_RECEPTIONIST', consentGiven: true },
    });

    expect(res.statusCode).toBe(200);
  });
});
