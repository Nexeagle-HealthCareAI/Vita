import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import WebSocket from 'ws';
import { BinaryFrameType, decodeBinaryFrame, encodeBinaryFrame } from '@vita/protocol';
import { buildServer } from '../src/index.js';
import { mockGroq, mockSarvam, mockHms } from './helpers.js';
import type { SarvamRealtimeSession } from '../src/sarvamRealtime.js';
import type { ConnectionOpenGate } from '../src/connectionGate.js';

/** Fakes SarvamRealtimeSession's public surface (registration-style onXxx callbacks,
 * not a single callbacks object -- see sarvamRealtime.ts) so these tests exercise the
 * real StreamSessionHandler wiring without a real Sarvam socket. Mirrors
 * wsRelay.integration.test.ts's/wsStreamingRelay.integration.test.ts's "real transport,
 * one hop faked out" approach one hop further down the chain. */
function fakeSarvamRealtime(opts: { connect?: () => Promise<void>; finalTranscriptOnSpeechEnd?: string } = {}) {
  let finalHandler: ((text: string) => void) | undefined;
  let fatalHandler: ((reason: string) => void) | undefined;
  const session = {
    onPartialTranscript: vi.fn(),
    onFinalTranscript: vi.fn((cb: (text: string) => void) => {
      finalHandler = cb;
    }),
    onFatal: vi.fn((cb: (reason: string) => void) => {
      fatalHandler = cb;
    }),
    connect: vi.fn(opts.connect ?? (() => Promise.resolve())),
    sendAudio: vi.fn(),
    sendSpeechStart: vi.fn(),
    sendSpeechEnd: vi.fn(() => {
      if (opts.finalTranscriptOnSpeechEnd !== undefined) {
        // Real Sarvam replies asynchronously over the wire -- defer so callers can't
        // accidentally depend on synchronous delivery.
        setTimeout(() => finalHandler?.(opts.finalTranscriptOnSpeechEnd!), 0);
      }
    }),
    end: vi.fn(),
    fireFatal: (reason: string) => fatalHandler?.(reason),
  };
  return session as unknown as SarvamRealtimeSession & { fireFatal: (reason: string) => void };
}

function fakeGate(): ConnectionOpenGate {
  return { acquire: vi.fn().mockResolvedValue(undefined) } as unknown as ConnectionOpenGate;
}

async function createSession(app: ReturnType<typeof buildServer>) {
  await app.inject({
    method: 'POST',
    url: '/session',
    payload: { sessionId: 'sess-1', userId: 'user-1', role: 'ROLE_RECEPTIONIST', consentGiven: true },
  });
}

/** Collects JSON control messages and binary frame payloads from a real ws client,
 * resolving `waitFor` promises as matching messages arrive. */
function collector(ws: WebSocket) {
  const jsonMessages: Record<string, unknown>[] = [];
  const binaryFrames: Uint8Array[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      binaryFrames.push(new Uint8Array(data));
    } else {
      jsonMessages.push(JSON.parse(data.toString()));
    }
  });
  return {
    jsonMessages,
    binaryFrames,
    waitForEvent: (event: string, timeout = 3000) =>
      vi.waitFor(
        () => {
          const found = jsonMessages.find((m) => m.event === event);
          if (!found) throw new Error(`event ${event} not received yet`);
          return found;
        },
        { timeout },
      ),
  };
}

describe('orchestrator streaming STT route (GET /session/:id/stream)', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.close();
    await app?.close();
  });

  it('full round trip: stream.ready -> transcript.final -> one binary reply, via the real runTurn pipeline', async () => {
    const groq = mockGroq([{ content: 'Sure, one moment.', toolCalls: [] }]);
    const sarvamBatch = mockSarvam(new Uint8Array([9, 9, 9]));
    const hms = mockHms();
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: 'is dr patel around' });

    app = buildServer(new RedisMock(), {
      groq,
      sarvam: sarvamBatch,
      hms,
      sarvamRealtimeFactory: () => sarvamRealtime,
      connectionGate: fakeGate(),
    });
    await createSession(app);
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');

    ws = new WebSocket(`ws://127.0.0.1:${address.port}/session/sess-1/stream`);
    ws.binaryType = 'nodebuffer';
    const c = collector(ws);
    await new Promise<void>((resolve, reject) => {
      ws!.on('open', resolve);
      ws!.on('error', reject);
    });

    await c.waitForEvent('stream.ready');
    ws.send(JSON.stringify({ event: 'speech_start' }));
    ws.send(encodeBinaryFrame(BinaryFrameType.AUDIO_INPUT_PCM16, new Uint8Array([1, 2, 3])));
    ws.send(JSON.stringify({ event: 'speech_end' }));

    await c.waitForEvent('transcript.final');
    expect(c.jsonMessages.find((m) => m.event === 'transcript.final')).toEqual({ event: 'transcript.final', text: 'is dr patel around' });

    await vi.waitFor(() => expect(c.binaryFrames.length).toBeGreaterThan(0));
    const { type, payload } = decodeBinaryFrame(c.binaryFrames[0]);
    expect(type).toBe(BinaryFrameType.AUDIO_OUTPUT_PCM16);
    expect(Array.from(payload)).toEqual([9, 9, 9]);

    expect(sarvamRealtime.sendSpeechStart).toHaveBeenCalledTimes(1);
    expect(sarvamRealtime.sendAudio).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(groq.chat).toHaveBeenCalledTimes(1);
  });

  it('closes with 4004 when the session does not exist', async () => {
    app = buildServer(new RedisMock(), {
      groq: mockGroq([]),
      sarvam: mockSarvam(),
      hms: mockHms(),
      sarvamRealtimeFactory: () => fakeSarvamRealtime(),
      connectionGate: fakeGate(),
    });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');

    ws = new WebSocket(`ws://127.0.0.1:${address.port}/session/does-not-exist/stream`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws!.on('close', (code) => resolve(code));
      ws!.on('error', reject);
      setTimeout(() => reject(new Error('timed out waiting for close')), 3000);
    });

    expect(closeCode).toBe(4004);
  });

  it('sends stream.unavailable when Sarvam realtime connect fails, then rejects further speech events with a recoverable turn.error', async () => {
    const sarvamRealtime = fakeSarvamRealtime({ connect: () => Promise.reject(new Error('quota_exceeded')) });

    app = buildServer(new RedisMock(), {
      groq: mockGroq([]),
      sarvam: mockSarvam(),
      hms: mockHms(),
      sarvamRealtimeFactory: () => sarvamRealtime,
      connectionGate: fakeGate(),
    });
    await createSession(app);
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');

    ws = new WebSocket(`ws://127.0.0.1:${address.port}/session/sess-1/stream`);
    ws.binaryType = 'nodebuffer';
    const c = collector(ws);
    await new Promise<void>((resolve, reject) => {
      ws!.on('open', resolve);
      ws!.on('error', reject);
    });

    const unavailable = await c.waitForEvent('stream.unavailable');
    expect(unavailable).toEqual({ event: 'stream.unavailable', reason: 'quota_exceeded' });

    ws.send(JSON.stringify({ event: 'speech_start' }));
    const turnError = await c.waitForEvent('turn.error');
    expect(turnError).toEqual({
      event: 'turn.error',
      code: 'STREAMING_STT_UNAVAILABLE',
      message: 'streaming STT connection is unavailable for this call',
      recoverable: true,
    });
  });

  it('an empty final transcript is a soft no-op: transcript.final with empty text, no binary reply, no groq call', async () => {
    const groq = mockGroq([]);
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: '   ' });

    app = buildServer(new RedisMock(), {
      groq,
      sarvam: mockSarvam(),
      hms: mockHms(),
      sarvamRealtimeFactory: () => sarvamRealtime,
      connectionGate: fakeGate(),
    });
    await createSession(app);
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');

    ws = new WebSocket(`ws://127.0.0.1:${address.port}/session/sess-1/stream`);
    ws.binaryType = 'nodebuffer';
    const c = collector(ws);
    await new Promise<void>((resolve, reject) => {
      ws!.on('open', resolve);
      ws!.on('error', reject);
    });

    await c.waitForEvent('stream.ready');
    ws.send(JSON.stringify({ event: 'speech_start' }));
    ws.send(JSON.stringify({ event: 'speech_end' }));

    await c.waitForEvent('transcript.final');
    expect(c.jsonMessages.find((m) => m.event === 'transcript.final')).toEqual({ event: 'transcript.final', text: '' });
    expect(c.binaryFrames.length).toBe(0);
    expect(groq.chat).not.toHaveBeenCalled();
  });

  it('a fatal mid-call Sarvam disconnect marks the call dead and sends a recoverable turn.error', async () => {
    const sarvamRealtime = fakeSarvamRealtime();

    app = buildServer(new RedisMock(), {
      groq: mockGroq([]),
      sarvam: mockSarvam(),
      hms: mockHms(),
      sarvamRealtimeFactory: () => sarvamRealtime,
      connectionGate: fakeGate(),
    });
    await createSession(app);
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');

    ws = new WebSocket(`ws://127.0.0.1:${address.port}/session/sess-1/stream`);
    const c = collector(ws);
    await new Promise<void>((resolve, reject) => {
      ws!.on('open', resolve);
      ws!.on('error', reject);
    });
    await c.waitForEvent('stream.ready');

    sarvamRealtime.fireFatal('connection closed unexpectedly: code=1011');

    const turnError = await c.waitForEvent('turn.error');
    expect(turnError).toEqual({
      event: 'turn.error',
      code: 'STREAMING_STT_UNAVAILABLE',
      message: 'connection closed unexpectedly: code=1011',
      recoverable: true,
    });
  });
});
