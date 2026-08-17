import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import { buildServer } from '../src/index.js';
import { mockGroq, mockStt, mockTts, mockHms } from './helpers.js';

async function createSession(app: ReturnType<typeof buildServer>, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/session',
    payload: { sessionId: 'sess-1', userId: 'user-1', role: 'ROLE_RECEPTIONIST', consentGiven: true, ...overrides },
  });
  return JSON.parse(res.body) as { sessionId: string };
}

describe('POST /session/:id/turn/audio', () => {
  it('transcribes, runs the turn, persists history, and returns transcript + reply + audio', async () => {
    const brain = mockGroq([{ content: 'Sure, one moment.', toolCalls: [] }]);
    const stt = mockStt('Is Dr. Patel around today?');
    const tts = mockTts(new Uint8Array([9, 9, 9]));
    const hms = mockHms();

    const app = buildServer(new RedisMock(), { brain, stt, tts, hms });
    await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: '/session/sess-1/turn/audio',
      payload: Buffer.from([1, 2, 3, 4]),
      headers: { 'content-type': 'application/octet-stream' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.transcript).toBe('Is Dr. Patel around today?');
    expect(body.replyText).toBe('Sure, one moment.');
    expect(body.audioBase64).toBe(Buffer.from([9, 9, 9]).toString('base64'));
    expect(body.toolCallsExecuted).toEqual([]);

    expect(stt.transcribe).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]));
  });

  it('stt.transcribe receives bytes byte-identical to the raw request body (guards the raw-body parser wiring)', async () => {
    const stt = mockStt();
    const app = buildServer(new RedisMock(), { brain: mockGroq([]), stt, tts: mockTts(), hms: mockHms() });
    await createSession(app);

    const payload = Buffer.from([10, 20, 30, 40, 50]);
    await app.inject({
      method: 'POST',
      url: '/session/sess-1/turn/audio',
      payload,
      headers: { 'content-type': 'application/octet-stream' },
    });

    expect(stt.transcribe).toHaveBeenCalledWith(new Uint8Array(payload));
  });

  it('empty/whitespace transcript is a soft no-op -- no brain or synthesize call, null reply fields', async () => {
    const brain = mockGroq([]);
    const stt = mockStt('   ');
    const tts = mockTts();
    const app = buildServer(new RedisMock(), { brain, stt, tts, hms: mockHms() });
    await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: '/session/sess-1/turn/audio',
      payload: Buffer.from([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [] });
    expect(brain.chat).not.toHaveBeenCalled();
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('STT failure returns 502 STT_FAILED, recoverable', async () => {
    const stt = mockStt();
    stt.transcribe = vi.fn().mockRejectedValue(new Error('sarvam is down'));
    const app = buildServer(new RedisMock(), { brain: mockGroq([]), stt, tts: mockTts(), hms: mockHms() });
    await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: '/session/sess-1/turn/audio',
      payload: Buffer.from([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'STT_FAILED', message: 'sarvam is down', recoverable: true } });
  });

  it('a runTurn failure (e.g. brain.chat rejects) returns 502 TURN_FAILED, recoverable', async () => {
    const brain = mockGroq([]);
    brain.chat = vi.fn().mockRejectedValue(new Error('groq is down'));
    const stt = mockStt('book me an appointment');
    const app = buildServer(new RedisMock(), { brain, stt, tts: mockTts(), hms: mockHms() });
    await createSession(app);

    const res = await app.inject({
      method: 'POST',
      url: '/session/sess-1/turn/audio',
      payload: Buffer.from([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'TURN_FAILED', message: 'groq is down', recoverable: true } });
  });

  it('unknown session id returns 404 SESSION_NOT_FOUND, not recoverable', async () => {
    const app = buildServer(new RedisMock(), { brain: mockGroq([]), stt: mockStt(), tts: mockTts(), hms: mockHms() });

    const res = await app.inject({
      method: 'POST',
      url: '/session/does-not-exist/turn/audio',
      payload: Buffer.from([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'SESSION_NOT_FOUND', message: 'session not found', recoverable: false } });
  });
});
