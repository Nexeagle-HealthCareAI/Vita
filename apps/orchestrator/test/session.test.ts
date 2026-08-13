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
      resumeToken: 'tok-2',
    });

    const updated = await store.update('s2', { turnState: 'LISTENING' });
    expect(updated?.turnState).toBe('LISTENING');

    await store.destroy('s2');
    expect(await store.get('s2')).toBeNull();
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
