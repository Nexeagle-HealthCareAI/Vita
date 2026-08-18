import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { BinaryFrameType, decodeBinaryFrame, encodeBinaryFrame } from '@vita/protocol';
import { OrchestratorStreamClient, type OrchestratorStreamCallbacks } from '../src/orchestratorStreamClient.js';

function fakeCallbacks(): OrchestratorStreamCallbacks {
  return {
    onPartialTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onReplyText: vi.fn(),
    onReplyAudio: vi.fn(),
    onFormAutofill: vi.fn(),
    onTurnError: vi.fn(),
    onDisconnected: vi.fn(),
  };
}

/** Real local ws.WebSocketServer standing in for the orchestrator's /session/:id/stream
 * route -- exercises the actual wire protocol (real sockets, real JSON/binary framing)
 * rather than a mocked WebSocket class, matching this suite's "verify the transport
 * itself" purpose (streamingTurnBackend.test.ts covers the state-machine logic above it
 * with a fake client instead). */
describe('OrchestratorStreamClient', () => {
  let wss: WebSocketServer;
  let baseWsUrl: string;
  let client: OrchestratorStreamClient | undefined;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('resolves "ready" once the server sends stream.ready', async () => {
    wss.once('connection', (socket) => {
      socket.send(JSON.stringify({ event: 'stream.ready' }));
    });
    client = new OrchestratorStreamClient(baseWsUrl);

    const outcome = await client.connect('sess-1', 1000, fakeCallbacks());
    expect(outcome).toBe('ready');
  });

  it('resolves "unavailable" when the server sends stream.unavailable', async () => {
    wss.once('connection', (socket) => {
      socket.send(JSON.stringify({ event: 'stream.unavailable', reason: 'gate timeout' }));
    });
    client = new OrchestratorStreamClient(baseWsUrl);

    const outcome = await client.connect('sess-1', 1000, fakeCallbacks());
    expect(outcome).toBe('unavailable');
  });

  it('resolves "unavailable" if the server closes the connection before ready', async () => {
    wss.once('connection', (socket) => {
      socket.close(4004, 'session not found');
    });
    client = new OrchestratorStreamClient(baseWsUrl);

    const outcome = await client.connect('sess-1', 1000, fakeCallbacks());
    expect(outcome).toBe('unavailable');
  });

  it('resolves "unavailable" on connect timeout when the server never responds', async () => {
    wss.once('connection', () => {
      // Never sends stream.ready -- simulates a hung/slow orchestrator.
    });
    client = new OrchestratorStreamClient(baseWsUrl);

    const outcome = await client.connect('sess-1', 50, fakeCallbacks());
    expect(outcome).toBe('unavailable');
  });

  it('never rejects even against an unreachable host (connection error settles to "unavailable")', async () => {
    client = new OrchestratorStreamClient('ws://127.0.0.1:1'); // reserved, always refused
    const outcome = await client.connect('sess-1', 1000, fakeCallbacks());
    expect(outcome).toBe('unavailable');
  });

  it('routes transcript.partial/transcript.final/turn.reply/turn.form_autofill/turn.error and binary AUDIO_OUTPUT_PCM16 to the right callbacks', async () => {
    let serverSocket: WsWebSocket;
    wss.once('connection', (socket) => {
      serverSocket = socket;
      socket.send(JSON.stringify({ event: 'stream.ready' }));
    });
    client = new OrchestratorStreamClient(baseWsUrl);
    const callbacks = fakeCallbacks();
    await client.connect('sess-1', 1000, callbacks);

    serverSocket!.send(JSON.stringify({ event: 'transcript.partial', text: 'hel' }));
    serverSocket!.send(JSON.stringify({ event: 'transcript.final', text: 'hello' }));
    serverSocket!.send(JSON.stringify({ event: 'turn.reply', text: 'hi there', final: true }));
    serverSocket!.send(JSON.stringify({ event: 'turn.form_autofill', data: { patientName: 'Riya Sharma' } }));
    serverSocket!.send(JSON.stringify({ event: 'turn.error', code: 'TURN_FAILED', message: 'boom', recoverable: true }));
    serverSocket!.send(encodeBinaryFrame(BinaryFrameType.AUDIO_OUTPUT_PCM16, new Uint8Array([1, 2, 3])));

    await vi.waitFor(() => expect(callbacks.onReplyAudio).toHaveBeenCalled());
    expect(callbacks.onPartialTranscript).toHaveBeenCalledWith('hel');
    expect(callbacks.onFinalTranscript).toHaveBeenCalledWith('hello');
    expect(callbacks.onReplyText).toHaveBeenCalledWith('hi there');
    expect(callbacks.onFormAutofill).toHaveBeenCalledWith({ patientName: 'Riya Sharma' });
    expect(callbacks.onTurnError).toHaveBeenCalledWith('TURN_FAILED', 'boom', true);
    // The binary frame immediately following a turn.reply{final:true} is correlated as
    // that chunk's own (final) audio -- see orchestratorStreamClient.ts's pendingReplyFinal.
    expect(callbacks.onReplyAudio).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), true);
  });

  it('correlates a turn.reply{final:false} with its own binary frame as isFinalChunk:false, per chunk', async () => {
    let serverSocket: WsWebSocket;
    wss.once('connection', (socket) => {
      serverSocket = socket;
      socket.send(JSON.stringify({ event: 'stream.ready' }));
    });
    client = new OrchestratorStreamClient(baseWsUrl);
    const callbacks = fakeCallbacks();
    await client.connect('sess-1', 1000, callbacks);

    // Chunk 1: non-final text immediately followed by its own audio frame.
    serverSocket!.send(JSON.stringify({ event: 'turn.reply', text: 'Sure, ', final: false }));
    serverSocket!.send(encodeBinaryFrame(BinaryFrameType.AUDIO_OUTPUT_PCM16, new Uint8Array([1])));
    await vi.waitFor(() => expect(callbacks.onReplyAudio).toHaveBeenCalledTimes(1));
    expect(callbacks.onReplyAudio).toHaveBeenNthCalledWith(1, new Uint8Array([1]), false);

    // Chunk 2: final text immediately followed by its own (final) audio frame.
    serverSocket!.send(JSON.stringify({ event: 'turn.reply', text: 'one moment.', final: true }));
    serverSocket!.send(encodeBinaryFrame(BinaryFrameType.AUDIO_OUTPUT_PCM16, new Uint8Array([2])));
    await vi.waitFor(() => expect(callbacks.onReplyAudio).toHaveBeenCalledTimes(2));
    expect(callbacks.onReplyAudio).toHaveBeenNthCalledWith(2, new Uint8Array([2]), true);
  });

  it('fires onDisconnected on an unexpected close after a successful connect, not before', async () => {
    let serverSocket: WsWebSocket;
    wss.once('connection', (socket) => {
      serverSocket = socket;
      socket.send(JSON.stringify({ event: 'stream.ready' }));
    });
    client = new OrchestratorStreamClient(baseWsUrl);
    const callbacks = fakeCallbacks();
    await client.connect('sess-1', 1000, callbacks);

    serverSocket!.close(1011, 'internal error');

    await vi.waitFor(() => expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1));
  });

  it('sendSpeechStart/sendSpeechEnd/sendAudioFrame write the documented wire shapes', async () => {
    const received: (string | Uint8Array)[] = [];
    wss.once('connection', (socket) => {
      socket.send(JSON.stringify({ event: 'stream.ready' }));
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        received.push(isBinary ? new Uint8Array(data) : data.toString());
      });
    });
    client = new OrchestratorStreamClient(baseWsUrl);
    await client.connect('sess-1', 1000, fakeCallbacks());

    client.sendSpeechStart();
    client.sendSpeechEnd();
    client.sendAudioFrame(new Uint8Array([9, 8, 7]));
    client.sendTurnAbort();

    await vi.waitFor(() => expect(received.length).toBe(4));
    expect(received[0]).toBe(JSON.stringify({ event: 'speech_start' }));
    expect(received[1]).toBe(JSON.stringify({ event: 'speech_end' }));
    const { type, payload } = decodeBinaryFrame(received[2] as Uint8Array);
    expect(type).toBe(BinaryFrameType.AUDIO_INPUT_PCM16);
    expect(Array.from(payload)).toEqual([9, 8, 7]);
    expect(received[3]).toBe(JSON.stringify({ event: 'turn.abort' }));
  });
});
