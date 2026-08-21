import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { BinaryFrameType, encodeBinaryFrame } from '@vita/protocol';
import { buildServer } from '../src/index.js';
import { AudioPreprocessClient } from '../src/audioPreprocessClient.js';
import { OrchestratorClient } from '../src/orchestratorClient.js';
import { DefaultTurnBackendFactory, OrchestratorStreamClient } from '../src/streamingTurnBackend.js';

// buildServer's JWT_SECRET is read once at module load from JWT_SIGNING_SECRET, defaulting
// to 'change-me' -- same convention wsRelay.integration.test.ts relies on.
const JWT_SECRET = 'change-me';

function fakeAudioPreprocess() {
  const client = Object.create(AudioPreprocessClient.prototype) as AudioPreprocessClient;
  let calls = 0;
  client.process = vi.fn(async (frame: Uint8Array) => ({ frame, speechDetected: calls++ < 4 }));
  client.teardown = vi.fn().mockResolvedValue(undefined);
  return client;
}

function fakeOrchestrator() {
  const client = Object.create(OrchestratorClient.prototype) as OrchestratorClient;
  client.createSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1', resumeToken: 'resume-tok-1', epoch: 1 });
  client.resumeSession = vi.fn().mockResolvedValue(null);
  client.postAudioTurn = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      transcript: 'is dr patel around',
      replyText: 'yes, until 5pm',
      audioBase64: Buffer.from(new Uint8Array(0)).toString('base64'),
      toolCallsExecuted: [],
    },
  });
  return client;
}

/**
 * Proves the STREAMING_STT_ENABLED=true path degrades a call to the existing batch path
 * end-to-end, rather than failing it, when the orchestrator's realtime stream is
 * unavailable -- e.g. a real Sarvam close code 1003 (rate limit/quota) bubbling up as the
 * orchestrator closing this WS with 1003 too. Uses a real local ws.WebSocketServer
 * standing in for the orchestrator's /session/:id/stream route (real sockets, real close
 * codes), same technique wsRelay.integration.test.ts uses one hop further down for the
 * orchestrator's HTTP routes.
 */
describe('gateway WS relay -- streaming-enabled call falls back to batch end to end when the orchestrator stream is unavailable', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  let orchestratorStreamServer: WebSocketServer | undefined;
  let ws: WebSocket | undefined;
  let audioPreprocess: ReturnType<typeof fakeAudioPreprocess> | undefined;

  afterEach(async () => {
    if (ws) {
      ws.close();
      if (audioPreprocess) {
        await vi.waitFor(() => expect(audioPreprocess!.teardown as Mock).toHaveBeenCalled(), { timeout: 2000 }).catch(() => {});
      }
    }
    await app?.close();
    await new Promise<void>((resolve) => (orchestratorStreamServer ? orchestratorStreamServer.close(() => resolve()) : resolve()));
    delete process.env.MIN_UTTERANCE_SPEECH_MS;
    delete process.env.UTTERANCE_SILENCE_MS;
  });

  it('immediately closes the stream with 1003 -> gateway falls back to batch -> the call still completes', async () => {
    process.env.MIN_UTTERANCE_SPEECH_MS = '20';
    process.env.UTTERANCE_SILENCE_MS = '20';

    orchestratorStreamServer = new WebSocketServer({ port: 0 });
    orchestratorStreamServer.on('connection', (socket) => {
      socket.close(1003, 'quota_exceeded'); // never sends stream.ready
    });
    await new Promise<void>((resolve) => orchestratorStreamServer!.once('listening', resolve));
    const streamAddress = orchestratorStreamServer.address();
    if (typeof streamAddress !== 'object' || streamAddress === null) throw new Error('no stream server address');
    const orchestratorWsBaseUrl = `ws://127.0.0.1:${streamAddress.port}`;

    audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const backendFactory = new DefaultTurnBackendFactory(orchestrator, () => new OrchestratorStreamClient(orchestratorWsBaseUrl), {
      streamingEnabled: true,
      connectTimeoutMs: 1000,
    });
    app = buildServer({ audioPreprocess, orchestrator, backendFactory });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');
    const port = address.port;

    const token = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
    const ticketRes = await app.inject({ method: 'POST', url: '/session/ticket', headers: { authorization: `Bearer ${token}` } });
    expect(ticketRes.statusCode).toBe(200);
    const { ticket } = JSON.parse(ticketRes.body) as { ticket: string };

    const received: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [`vita-ticket.${ticket}`]);
      ws.binaryType = 'nodebuffer';

      ws.on('open', () => {
        // Unlike wsRelay.integration.test.ts's pure-batch happy path, relay.start() here
        // does a real socket round trip to the fake orchestrator stream server before
        // resolving (open -> close(1003) -> settle('unavailable')) -- so sessionId isn't
        // set the instant the client's WS opens. Sent with NO delay, deliberately -- this
        // used to require an artificial setTimeout here because processFrame() dropped any
        // frame that arrived before start() resolved; now it awaits start() instead (see
        // relay.ts's sessionReady), so these frames are buffered-by-waiting and still
        // processed once the real (streaming-fallback) session is established, proving
        // that fix rather than working around the bug it fixed.
        for (let i = 0; i < 5; i++) {
          ws!.send(encodeBinaryFrame(BinaryFrameType.AUDIO_INPUT_PCM16, new Uint8Array([i])));
        }
      });

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          const event = JSON.parse(data.toString()) as { event: string };
          received.push(event);
          if (event.event === 'STATE_CHANGE' && (event as { state: string }).state === 'LISTENING' && received.length > 1) {
            resolve();
          }
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('timed out waiting for the fallback round trip')), 5000);
    });

    // The batch fallback's own HTTP call is what actually completed this turn -- proves
    // the degrade was real, not a lucky no-op.
    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1);
    expect(received).toEqual([
      { event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'resume-tok-1', resumed: false },
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'TRANSCRIPT', text: 'is dr patel around', is_final: true },
      { event: 'REPLY_TEXT', text: 'yes, until 5pm' },
      { event: 'STATE_CHANGE', state: 'SPEAKING' },
      { event: 'STATE_CHANGE', state: 'LISTENING' },
    ]);
  });
});
