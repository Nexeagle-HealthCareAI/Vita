import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ioredis-mock has no bundled types
import RedisMock from 'ioredis-mock';
import WebSocket from 'ws';
import { BinaryFrameType, decodeBinaryFrame, encodeBinaryFrame } from '@vita/protocol';
import { buildServer } from '../src/index.js';
import { StreamSessionHandler } from '../src/streamSession.js';
import { mockGroq, mockGroqStream, mockStt, mockTts, mockHms } from './helpers.js';
import type { SarvamRealtimeSttSession } from '../src/stt/sarvamRealtime.js';
import type { ConnectionOpenGate } from '../src/connectionGate.js';

/** Fakes SarvamRealtimeSttSession's public surface (registration-style onXxx callbacks,
 * not a single callbacks object -- see stt/sarvamRealtime.ts) so these tests exercise
 * the real StreamSessionHandler wiring without a real Sarvam socket. Mirrors
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
  return session as unknown as SarvamRealtimeSttSession & { fireFatal: (reason: string) => void };
}

function fakeGate(): ConnectionOpenGate {
  return { acquire: vi.fn().mockResolvedValue(undefined) } as unknown as ConnectionOpenGate;
}

async function createSession(app: ReturnType<typeof buildServer>) {
  await app.inject({
    method: 'POST',
    url: '/session',
    payload: { sessionId: 'sess-1', userId: 'user-1', consentGiven: true, hmsAccessToken: 'test-staff-token' },
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

  it('full round trip: stream.ready -> transcript.final -> one final turn.reply + binary chunk, via the real streaming runTurn pipeline', async () => {
    // "Sure, one moment." has no trailing whitespace after its period in this single
    // content delta, so splitCompletedSentences never sees a confirmed boundary mid-
    // stream -- it's flushed whole as the turn's one (isFinal:true) chunk once the
    // stream ends, exactly mirroring what a real one-sentence reply looks like.
    const brain = mockGroqStream([[{ contentDelta: 'Sure, one moment.', done: false }, { done: true, toolCalls: undefined }]]);
    const tts = mockTts(new Uint8Array([9, 9, 9]));
    const hms = mockHms();
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: 'is dr patel around' });

    app = buildServer(new RedisMock(), {
      brain,
      stt: mockStt(),
      tts,
      hms,
      streamingSttSessionFactory: () => sarvamRealtime,
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

    await c.waitForEvent('turn.reply');
    expect(c.jsonMessages.find((m) => m.event === 'turn.reply')).toEqual({ event: 'turn.reply', text: 'Sure, one moment.', final: true });

    await vi.waitFor(() => expect(c.binaryFrames.length).toBeGreaterThan(0));
    const { type, payload } = decodeBinaryFrame(c.binaryFrames[0]);
    expect(type).toBe(BinaryFrameType.AUDIO_OUTPUT_PCM16);
    expect(Array.from(payload)).toEqual([9, 9, 9]);

    expect(sarvamRealtime.sendSpeechStart).toHaveBeenCalledTimes(1);
    expect(sarvamRealtime.sendAudio).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(brain.chatStream).toHaveBeenCalledTimes(1);
  });

  it('a multi-sentence reply streams one turn.reply + binary chunk pair per sentence, only the last marked final', async () => {
    const brain = mockGroqStream([
      [
        { contentDelta: 'Sure, one moment. ', done: false },
        { contentDelta: "I'll check that for you.", done: false },
        { done: true, toolCalls: undefined },
      ],
    ]);
    const tts = mockTts(new Uint8Array([9, 9, 9]));
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: 'is dr patel around' });

    app = buildServer(new RedisMock(), {
      brain,
      stt: mockStt(),
      tts,
      hms: mockHms(),
      streamingSttSessionFactory: () => sarvamRealtime,
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

    await vi.waitFor(() => expect(c.jsonMessages.filter((m) => m.event === 'turn.reply').length).toBe(2));
    const replies = c.jsonMessages.filter((m) => m.event === 'turn.reply');
    expect(replies[0]).toEqual({ event: 'turn.reply', text: 'Sure, one moment. ', final: false });
    expect(replies[1]).toEqual({ event: 'turn.reply', text: "I'll check that for you.", final: true });
    expect(c.binaryFrames.length).toBe(2); // one paired frame per chunk, in the same order
  });

  it('sends turn.form_autofill with the new slot values once per turn, after a tool call establishes them', async () => {
    const brain = mockGroqStream([
      [
        {
          done: true,
          toolCalls: [
            {
              id: 'call_1',
              name: 'book_appointment',
              arguments: { doctorId: 'd-1', patientName: 'Riya Sharma', patientMobile: '9999999999', preferredDate: '2026-08-20' },
            },
          ],
        },
      ],
      [{ contentDelta: "Booked -- we'll confirm the exact time with you shortly.", done: false }, { done: true, toolCalls: undefined }],
    ]);
    const tts = mockTts(new Uint8Array([9, 9, 9]));
    const hms = mockHms();
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: 'book Riya Sharma with Dr Patel on the 20th, mobile 9999999999' });

    app = buildServer(new RedisMock(), {
      brain,
      stt: mockStt(),
      tts,
      hms,
      streamingSttSessionFactory: () => sarvamRealtime,
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

    const autofill = await c.waitForEvent('turn.form_autofill');
    expect(autofill).toEqual({
      event: 'turn.form_autofill',
      data: { doctorId: 'd-1', patientName: 'Riya Sharma', patientMobile: '9999999999', preferredDate: '2026-08-20' },
    });
  });

  it('does not send turn.form_autofill when no slots changed this turn', async () => {
    const brain = mockGroqStream([[{ contentDelta: 'Sure, one moment.', done: false }, { done: true, toolCalls: undefined }]]);
    const tts = mockTts(new Uint8Array([9, 9, 9]));
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: 'is dr patel around' });

    app = buildServer(new RedisMock(), {
      brain,
      stt: mockStt(),
      tts,
      hms: mockHms(),
      streamingSttSessionFactory: () => sarvamRealtime,
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

    await c.waitForEvent('turn.reply');
    expect(c.jsonMessages.find((m) => m.event === 'turn.form_autofill')).toBeUndefined();
  });

  it('a book_appointment that succeeds on the FINAL allowed round is reported back via the grounding round, not a generic fallback (streaming path)', async () => {
    // Streaming-path counterpart to pipeline.test.ts's identical non-streaming regression
    // test -- both paths implement the MAX_TOOL_ROUNDS grounding-round fix independently.
    const brain = mockGroqStream([
      [{ done: true, toolCalls: [{ id: 'c1', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', preferredDate: '2026-08-20' } }] }],
      [{ done: true, toolCalls: [{ id: 'c2', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', preferredDate: '2026-08-20' } }] }],
      [
        {
          done: true,
          toolCalls: [
            { id: 'c3', name: 'book_appointment', arguments: { doctorId: 'd-1', patientName: 'Riya Sharma', patientMobile: '9999999999', preferredDate: '2026-08-20' } },
          ],
        },
      ],
      [{ contentDelta: "You're all set.", done: false }, { done: true, toolCalls: undefined }],
    ]);
    const tts = mockTts(new Uint8Array([9, 9, 9]));
    const hms = mockHms();
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: 'book Riya Sharma with Dr Patel, mobile 9999999999' });

    app = buildServer(new RedisMock(), {
      brain,
      stt: mockStt(),
      tts,
      hms,
      streamingSttSessionFactory: () => sarvamRealtime,
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

    const reply = await c.waitForEvent('turn.reply');
    expect(reply).toEqual({ event: 'turn.reply', text: "You're all set.", final: true });
    expect(hms.bookAppointment).toHaveBeenCalledTimes(1);
    expect(brain.chatStream).toHaveBeenCalledTimes(4);
  });

  it('closes with 4004 when the session does not exist', async () => {
    app = buildServer(new RedisMock(), {
      brain: mockGroq([]),
      stt: mockStt(),
      tts: mockTts(),
      hms: mockHms(),
      streamingSttSessionFactory: () => fakeSarvamRealtime(),
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
      brain: mockGroq([]),
      stt: mockStt(),
      tts: mockTts(),
      hms: mockHms(),
      streamingSttSessionFactory: () => sarvamRealtime,
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

  it('an empty final transcript is a soft no-op: transcript.final with empty text, no binary reply, no brain call', async () => {
    const brain = mockGroq([]);
    const sarvamRealtime = fakeSarvamRealtime({ finalTranscriptOnSpeechEnd: '   ' });

    app = buildServer(new RedisMock(), {
      brain,
      stt: mockStt(),
      tts: mockTts(),
      hms: mockHms(),
      streamingSttSessionFactory: () => sarvamRealtime,
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
    expect(brain.chatStream).not.toHaveBeenCalled();
  });

  it('a fatal mid-call Sarvam disconnect marks the call dead and sends a recoverable turn.error', async () => {
    const sarvamRealtime = fakeSarvamRealtime();

    app = buildServer(new RedisMock(), {
      brain: mockGroq([]),
      stt: mockStt(),
      tts: mockTts(),
      hms: mockHms(),
      streamingSttSessionFactory: () => sarvamRealtime,
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

  it('a client disconnect while Sarvam realtime connect() is still in flight ends that connection once it resolves, instead of leaking it', async () => {
    let resolveConnect!: () => void;
    const sarvamRealtime = fakeSarvamRealtime({ connect: () => new Promise((resolve) => { resolveConnect = resolve; }) });

    app = buildServer(new RedisMock(), {
      brain: mockGroq([]),
      stt: mockStt(),
      tts: mockTts(),
      hms: mockHms(),
      streamingSttSessionFactory: () => sarvamRealtime,
      connectionGate: fakeGate(),
    });
    await createSession(app);
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');

    ws = new WebSocket(`ws://127.0.0.1:${address.port}/session/sess-1/stream`);
    await new Promise<void>((resolve, reject) => {
      ws!.on('open', resolve);
      ws!.on('error', reject);
    });

    // Close before Sarvam's connect() resolves -- init() is still awaiting it when the
    // server's own 'close' handler (index.ts) runs handler.onClose(), which previously
    // found this.sttSession still undefined (assigned only after connect() resolves) and
    // had nothing to end().
    const closed = new Promise<void>((resolve) => ws!.on('close', () => resolve()));
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 20)); // let the server-side close handler run

    resolveConnect();
    await vi.waitFor(() => expect(sarvamRealtime.end).toHaveBeenCalledTimes(1));
  });
});

describe('StreamSessionHandler.sendJson -- closed-socket safety', () => {
  it('never calls socket.send() (which THROWS, not no-ops, on a non-OPEN socket) once the socket has closed', async () => {
    // ws's real WebSocket.send() throws when readyState isn't OPEN. sendJson() is called
    // from several places with no surrounding try/catch, and a throw inside a synchronous
    // 'message' event handler callback (see index.ts's socket.on('message', ...)) isn't
    // caught by anything -- an uncaught exception that can crash the whole process. This
    // constructs the handler directly (bypassing the real WS transport) so the fake
    // socket's readyState can be deterministically non-OPEN right when init()'s failure
    // path tries to report it, which is awkward to race reliably through a real socket.
    const send = vi.fn(() => {
      throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
    });
    const fakeSocket = { readyState: 3, OPEN: 1, send } as unknown as WebSocket;

    const handler = new StreamSessionHandler('sess-1', fakeSocket, {
      sessions: {} as never, // init() never touches sessions -- only handleFinalTranscript does
      brain: mockGroq([]),
      tts: mockTts(),
      hms: mockHms(),
      rosterTextPromise: Promise.resolve(undefined),
      streamingSttSessionFactory: () =>
        ({
          onPartialTranscript: vi.fn(),
          onFinalTranscript: vi.fn(),
          onFatal: vi.fn(),
          connect: vi.fn().mockRejectedValue(new Error('quota_exceeded')),
          sendAudio: vi.fn(),
          sendSpeechStart: vi.fn(),
          sendSpeechEnd: vi.fn(),
          end: vi.fn(),
        }) as unknown as SarvamRealtimeSttSession,
      connectionGate: fakeGate(),
      connectTimeoutMs: 100,
      gateMaxWaitMs: 100,
    });

    await expect(handler.init()).resolves.not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
