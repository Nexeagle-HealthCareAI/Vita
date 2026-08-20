import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { SessionStore } from '../src/session.js';

describe('SessionStore (backed by ioredis-mock)', () => {
  it('creates, reads back, and resumes a session by token', async () => {
    const store = new SessionStore(new RedisMock());
    const created = await store.create({
      sessionId: 's1',
      userId: 'u1',
      persona: 'ROLE_RECEPTIONIST',
      permissions: [],
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: 'tok-1',
    });

    const fetched = await store.get('s1');
    expect(fetched?.userId).toBe('u1');

    const resumed = await store.resume('s1', 'tok-1');
    expect(resumed?.sessionId).toBe('s1');

    const wrongToken = await store.resume('s1', 'wrong');
    expect(wrongToken).toBeNull();

    expect(created.turnState).toBe('IDLE');
  });

  it('hospitalId/hmsAccessToken (real-staff-JWT forwarding) round-trip through create, get, and resume', async () => {
    const store = new SessionStore(new RedisMock());
    await store.create({
      sessionId: 's1b',
      userId: 'u1',
      persona: 'ROLE_RECEPTIONIST',
      permissions: [],
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: 'tok-1b',
      hospitalId: 'h-1',
      hmsAccessToken: 'real-staff-jwt',
    });

    const fetched = await store.get('s1b');
    expect(fetched?.hospitalId).toBe('h-1');
    expect(fetched?.hmsAccessToken).toBe('real-staff-jwt');

    const resumed = await store.resume('s1b', 'tok-1b');
    expect(resumed?.hospitalId).toBe('h-1');
    expect(resumed?.hmsAccessToken).toBe('real-staff-jwt');
  });

  it('update() merges fields and destroy() removes the session', async () => {
    const store = new SessionStore(new RedisMock());
    await store.create({
      sessionId: 's2',
      userId: 'u2',
      persona: 'ROLE_DOCTOR',
      permissions: ['doc_board'],
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: 'tok-2',
    });

    const updated = await store.update('s2', { turnState: 'LISTENING' });
    expect(updated?.turnState).toBe('LISTENING');

    await store.destroy('s2');
    expect(await store.get('s2')).toBeNull();
  });

  it('resume() refreshes the TTL on both key prefixes but leaves resumeToken unchanged', async () => {
    const redis = new RedisMock();
    const store = new SessionStore(redis);
    await store.create({
      sessionId: 's3',
      userId: 'u3',
      persona: 'ROLE_RECEPTIONIST',
      permissions: [],
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: 'tok-3',
    });
    await redis.expire('vita:session:s3', 5);
    await redis.expire('tera:session:s3', 5);

    const resumed = await store.resume('s3', 'tok-3');

    expect(resumed?.resumeToken).toBe('tok-3');
    expect(await redis.ttl('vita:session:s3')).toBeGreaterThan(60);
    expect(await redis.ttl('tera:session:s3')).toBeGreaterThan(60);
  });

  it('rotateResumeToken() mints a new token, refreshes TTL, and invalidates the old token', async () => {
    const store = new SessionStore(new RedisMock());
    await store.create({
      sessionId: 's4',
      userId: 'u4',
      persona: 'ROLE_RECEPTIONIST',
      permissions: [],
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: 'tok-4',
    });

    const rotated = await store.rotateResumeToken('s4');

    expect(rotated?.resumeToken).toBeDefined();
    expect(rotated?.resumeToken).not.toBe('tok-4');
    expect(await store.resume('s4', 'tok-4')).toBeNull();
    expect((await store.resume('s4', rotated!.resumeToken))?.sessionId).toBe('s4');
  });

  it('rotateResumeToken() on an unknown sessionId returns null', async () => {
    const store = new SessionStore(new RedisMock());
    expect(await store.rotateResumeToken('does-not-exist')).toBeNull();
  });

  it('reads sessions written with the legacy Tera key prefix', async () => {
    const redis = new RedisMock();
    const store = new SessionStore(redis);
    await redis.set(
      'tera:session:legacy',
      JSON.stringify({
        sessionId: 'legacy',
        userId: 'u-legacy',
        role: 'ROLE_RECEPTIONIST', // genuinely old shape -- pre-persona/permissions rename
        turnState: 'IDLE',
        slots: {},
        resumeToken: 'legacy-token',
        updatedAt: Date.now(),
      }),
    );

    expect((await store.get('legacy'))?.userId).toBe('u-legacy');
  });
});

describe('SessionStore encryption at rest (SESSION_ENCRYPTION_KEY, docs/BUILD_GUIDE.md §6)', () => {
  afterEach(() => {
    delete process.env.SESSION_ENCRYPTION_KEY;
  });

  it('with no key configured, stores plain JSON -- unchanged from today', async () => {
    const redis = new RedisMock();
    const store = new SessionStore(redis);
    await store.create({
      sessionId: 'plain-1',
      userId: 'u-plain',
      persona: 'ROLE_RECEPTIONIST',
      permissions: [],
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: 'tok-plain',
    });

    const raw = await redis.get('vita:session:plain-1');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).toContain('u-plain');
  });

  it('with a key configured, the raw Redis value is not plaintext JSON, but get() still returns the correct session', async () => {
    process.env.SESSION_ENCRYPTION_KEY = 'test-session-encryption-key';
    const redis = new RedisMock();
    const store = new SessionStore(redis);
    await store.create({
      sessionId: 'enc-1',
      userId: 'u-secret',
      persona: 'ROLE_RECEPTIONIST',
      permissions: [],
      turnState: 'IDLE',
      slots: { patient_name: 'Asha Verma' },
      history: [],
      resumeToken: 'tok-enc',
    });

    const raw = await redis.get('vita:session:enc-1');
    expect(() => JSON.parse(raw)).toThrow();
    expect(raw).not.toContain('u-secret');
    expect(raw).not.toContain('Asha Verma');

    const fetched = await store.get('enc-1');
    expect(fetched?.userId).toBe('u-secret');
    expect(fetched?.slots.patient_name).toBe('Asha Verma');
  });
});
