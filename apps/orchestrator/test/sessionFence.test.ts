import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { buildServer } from '../src/index.js';
import { SessionStore } from '../src/session.js';
import { mockGroq, mockStt, mockTts, mockHms } from './helpers.js';
import type { BrainProvider, ChatResult } from '../src/brain/types.js';
import { GroqBrainProvider } from '../src/brain/groq.js';

/** A brain whose first chat() call hangs until the test releases it, so a turn can be
 * held mid-flight while other requests are driven against the same session. Deterministic
 * by construction -- no timing/sleep races. Each call returns a DISTINCT reply so an
 * assertion can tell which turn's write actually landed. */
function pausableGroq() {
  const brain = Object.create(GroqBrainProvider.prototype) as BrainProvider;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let call = 0;
  brain.chat = vi.fn(async (): Promise<ChatResult> => {
    call++;
    const which = call;
    if (which === 1) await gate; // only the first turn is held
    return { content: `reply-from-chat-call-${which}`, toolCalls: [] };
  });
  brain.chatStream = vi.fn();
  return { brain, release: () => release() };
}

async function createSession(app: ReturnType<typeof buildServer>, sessionId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/session',
    payload: { sessionId, userId: 'user-1', consentGiven: true },
  });
  return JSON.parse(res.body) as { sessionId: string; resumeToken: string };
}

describe('write-time epoch fence (a superseded connection must not clobber a newer one)', () => {
  it('refuses a stale in-flight turn\'s write after a resume bumped the epoch, and keeps the newer turn\'s history', async () => {
    // This is the exact interleaving that is reachable on a SINGLE instance today:
    //   A speaks -> Groq is thinking (seconds) -> WiFi blips -> client resumes ->
    //   B speaks and completes -> A's original turn finally returns and writes its
    //   stale snapshot, wiping B's turn.
    const { brain, release } = pausableGroq();
    const redis = new RedisMock();
    const app = buildServer(redis, { brain, stt: mockStt(), tts: mockTts(), hms: mockHms() });
    const store = new SessionStore(redis);
    const created = await createSession(app, 'sess-1');

    // Turn A starts and hangs inside runTurn (Groq gate), exactly like a real 2-4s call.
    const turnA = app.inject({ method: 'POST', url: '/session/sess-1/turn', payload: { transcript: 'turn A' } });
    await vi.waitFor(() => expect((brain.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));

    // The client reconnects and resumes -- this bumps the epoch, superseding turn A.
    const resumed = await app.inject({
      method: 'POST',
      url: '/session/sess-1/resume',
      payload: { resumeToken: created.resumeToken, userId: 'user-1' },
    });
    expect(resumed.statusCode).toBe(200);

    // Turn B (the new connection) runs to completion and persists.
    const turnB = await app.inject({ method: 'POST', url: '/session/sess-1/turn', payload: { transcript: 'turn B' } });
    expect(turnB.statusCode).toBe(200);
    const afterB = await store.get('sess-1');
    expect(JSON.stringify(afterB?.history)).toContain('turn B');

    // Now turn A finally finishes. Its write must be REFUSED, not silently applied.
    release();
    const resA = await turnA;
    expect(resA.statusCode).toBe(502);
    expect(JSON.parse(resA.body).error.code).toBe('SESSION_SUPERSEDED');
    expect(JSON.parse(resA.body).error.recoverable).toBe(false);

    // The decisive assertion: the surviving history is turn B's, and turn A's stale
    // snapshot never landed. Asserted on the USER transcripts, which are unambiguously
    // distinct per turn -- turn A's snapshot was taken before turn B existed, so if it
    // had won, history would carry "turn A" and NOT "turn B".
    const finalHistory = JSON.stringify((await store.get('sess-1'))?.history);
    expect(finalHistory).toContain('turn B');
    expect(finalHistory).not.toContain('turn A');
    // ...and it's turn B's reply (chat call #2) that's recorded, not the held turn's.
    expect(finalHistory).toContain('reply-from-chat-call-2');
    expect(finalHistory).not.toContain('reply-from-chat-call-1');
  });

  it('an ordinary single-connection conversation never fences -- three turns all persist', async () => {
    // Guard against the highest-risk failure mode of this change: if expectedEpoch were
    // threaded wrong, every turn would be refused, history would stop growing, and the
    // assistant would silently forget everything mid-call.
    const brain = mockGroq([
      { content: 'reply 1', toolCalls: [] },
      { content: 'reply 2', toolCalls: [] },
      { content: 'reply 3', toolCalls: [] },
    ]);
    const redis = new RedisMock();
    const app = buildServer(redis, { brain, stt: mockStt(), tts: mockTts(), hms: mockHms() });
    const store = new SessionStore(redis);
    await createSession(app, 'sess-1');

    for (const transcript of ['one', 'two', 'three']) {
      const res = await app.inject({ method: 'POST', url: '/session/sess-1/turn', payload: { transcript } });
      expect(res.statusCode).toBe(200);
    }

    // system + 3x(user + assistant) = 7
    expect((await store.get('sess-1'))?.history).toHaveLength(7);
  });

  it('a turn started AFTER a resume writes fine -- the fence only rejects genuinely stale epochs', async () => {
    const brain = mockGroq([{ content: 'post-resume reply', toolCalls: [] }]);
    const redis = new RedisMock();
    const app = buildServer(redis, { brain, stt: mockStt(), tts: mockTts(), hms: mockHms() });
    const store = new SessionStore(redis);
    const created = await createSession(app, 'sess-1');

    await app.inject({
      method: 'POST',
      url: '/session/sess-1/resume',
      payload: { resumeToken: created.resumeToken, userId: 'user-1' },
    });

    const res = await app.inject({ method: 'POST', url: '/session/sess-1/turn', payload: { transcript: 'after resume' } });

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify((await store.get('sess-1'))?.history)).toContain('post-resume reply');
  });
});

describe('SessionStore.update epoch semantics', () => {
  function store() {
    return new SessionStore(new RedisMock());
  }

  const base = {
    sessionId: 's1',
    userId: 'u1',
    persona: 'ROLE_RECEPTIONIST' as const,
    permissions: [],
    turnState: 'IDLE' as const,
    slots: {},
    history: [],
    resumeToken: 'tok',
  };

  it('omitting expectedEpoch writes unconditionally -- byte-identical to pre-fence behavior', async () => {
    const s = store();
    await s.create({ ...base, epoch: 5 });

    const updated = await s.update('s1', { turnState: 'SPEAKING' });

    expect(updated?.turnState).toBe('SPEAKING');
  });

  it('a matching expectedEpoch writes', async () => {
    const s = store();
    await s.create({ ...base, epoch: 5 });

    const updated = await s.update('s1', { turnState: 'SPEAKING' }, { expectedEpoch: 5 });

    expect(updated?.turnState).toBe('SPEAKING');
  });

  it('a mismatched expectedEpoch returns null and writes NOTHING', async () => {
    const s = store();
    await s.create({ ...base, epoch: 6 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const updated = await s.update('s1', { turnState: 'SPEAKING' }, { expectedEpoch: 5 });

    expect(updated).toBeNull();
    expect((await s.get('s1'))?.turnState).toBe('IDLE'); // untouched
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SESSION_WRITE_FENCED'));
    warn.mockRestore();
  });

  it('a session persisted before epoch existed (undefined) reads as 0 and fences against 0', async () => {
    const s = store();
    await s.create(base); // no epoch field at all

    expect(await s.update('s1', { turnState: 'SPEAKING' }, { expectedEpoch: 0 })).not.toBeNull();
    expect(await s.update('s1', { turnState: 'LISTENING' }, { expectedEpoch: 1 })).toBeNull();
  });

  it('rotateResumeToken increments the epoch in the same write as the token rotation', async () => {
    const s = store();
    await s.create({ ...base, epoch: 1 });

    const rotated = await s.rotateResumeToken('s1');

    expect(rotated?.epoch).toBe(2);
    expect(rotated?.resumeToken).not.toBe('tok');
  });
});
