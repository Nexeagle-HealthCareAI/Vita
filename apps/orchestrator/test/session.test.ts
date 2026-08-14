import { describe, expect, it } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { SessionStore } from '../src/session.js';

describe('SessionStore (backed by ioredis-mock)', () => {
  it('creates, reads back, and resumes a session by token', async () => {
    const store = new SessionStore(new RedisMock());
    const created = await store.create({
      sessionId: 's1',
      userId: 'u1',
      role: 'ROLE_RECEPTIONIST',
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

  it('update() merges fields and destroy() removes the session', async () => {
    const store = new SessionStore(new RedisMock());
    await store.create({
      sessionId: 's2',
      userId: 'u2',
      role: 'ROLE_DOCTOR',
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
      role: 'ROLE_RECEPTIONIST',
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
      role: 'ROLE_RECEPTIONIST',
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
        role: 'ROLE_RECEPTIONIST',
        turnState: 'IDLE',
        slots: {},
        resumeToken: 'legacy-token',
        updatedAt: Date.now(),
      }),
    );

    expect((await store.get('legacy'))?.userId).toBe('u-legacy');
  });
});
