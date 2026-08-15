import { describe, expect, it } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { buildServer } from '../src/index.js';
import { SessionStore } from '../src/session.js';
import { mockGroq, mockSarvam, mockHms } from './helpers.js';

async function createSession(app: ReturnType<typeof buildServer>, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/session',
    payload: { sessionId: 'sess-1', userId: 'user-1', role: 'ROLE_RECEPTIONIST', consentGiven: true, ...overrides },
  });
  return JSON.parse(res.body) as { sessionId: string; resumeToken: string };
}

describe('POST /session/:id/resume', () => {
  it('happy path: returns a different resumeToken, and history from before the "reconnect" carries over', async () => {
    const groq = mockGroq([
      { content: 'Sure, one moment.', toolCalls: [] },
      { content: 'anything else?', toolCalls: [] },
    ]);
    const redis = new RedisMock();
    const app = buildServer(redis, { groq, sarvam: mockSarvam(), hms: mockHms() });
    const created = await createSession(app);

    await app.inject({ method: 'POST', url: '/session/sess-1/turn', payload: { transcript: 'is dr patel around' } });

    const res = await app.inject({
      method: 'POST',
      url: '/session/sess-1/resume',
      payload: { resumeToken: created.resumeToken, userId: 'user-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { sessionId: string; resumeToken: string };
    expect(body.sessionId).toBe('sess-1');
    expect(body.resumeToken).not.toBe(created.resumeToken);

    await app.inject({ method: 'POST', url: '/session/sess-1/turn', payload: { transcript: 'book me an appointment' } });

    // Proves the SAME session/history is reused across "resume," not a fresh one: turn 1
    // persists [system, user, assistant] (3 messages); turn 2, after resume, appends its
    // own [user, assistant] on top of that -- [system, user, assistant, user, assistant] = 5.
    // Checked via the actual persisted session (not the mock's captured args -- runTurn
    // mutates that array in place after the call, so inspecting it later reflects its
    // FINAL state, not what was passed at call time).
    const store = new SessionStore(redis);
    const persisted = await store.get('sess-1');
    expect(persisted?.history.length).toBe(5);
  });

  it('wrong token returns 404, identical body shape to every other failure case', async () => {
    const app = buildServer(new RedisMock(), { groq: mockGroq([]), sarvam: mockSarvam(), hms: mockHms() });
    await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: '/session/sess-1/resume',
      payload: { resumeToken: 'not-the-real-token', userId: 'user-1' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'session not found' });
  });

  it('right token, wrong userId returns the same 404 shape', async () => {
    const app = buildServer(new RedisMock(), { groq: mockGroq([]), sarvam: mockSarvam(), hms: mockHms() });
    const created = await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: '/session/sess-1/resume',
      payload: { resumeToken: created.resumeToken, userId: 'someone-else' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'session not found' });
  });

  it('missing resumeToken or userId in the body returns the same 404 shape', async () => {
    const app = buildServer(new RedisMock(), { groq: mockGroq([]), sarvam: mockSarvam(), hms: mockHms() });
    await createSession(app);

    const res1 = await app.inject({ method: 'POST', url: '/session/sess-1/resume', payload: { userId: 'user-1' } });
    const res2 = await app.inject({ method: 'POST', url: '/session/sess-1/resume', payload: { resumeToken: 'tok' } });

    expect(res1.statusCode).toBe(404);
    expect(JSON.parse(res1.body)).toEqual({ error: 'session not found' });
    expect(res2.statusCode).toBe(404);
    expect(JSON.parse(res2.body)).toEqual({ error: 'session not found' });
  });

  it('an unknown sessionId returns the same 404 shape as every other failure case', async () => {
    const app = buildServer(new RedisMock(), { groq: mockGroq([]), sarvam: mockSarvam(), hms: mockHms() });

    const res = await app.inject({
      method: 'POST',
      url: '/session/does-not-exist/resume',
      payload: { resumeToken: 'tok', userId: 'user-1' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'session not found' });
  });

  it('a resume using an already-rotated (stale) token fails -- proves single-use-per-resume', async () => {
    const app = buildServer(new RedisMock(), { groq: mockGroq([]), sarvam: mockSarvam(), hms: mockHms() });
    const created = await createSession(app);

    const first = await app.inject({
      method: 'POST',
      url: '/session/sess-1/resume',
      payload: { resumeToken: created.resumeToken, userId: 'user-1' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/session/sess-1/resume',
      payload: { resumeToken: created.resumeToken, userId: 'user-1' }, // reusing the now-stale original token
    });

    expect(second.statusCode).toBe(404);
    expect(JSON.parse(second.body)).toEqual({ error: 'session not found' });
  });
});
