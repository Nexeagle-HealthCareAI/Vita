import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { BinaryFrameType, encodeBinaryFrame } from '@vita/protocol';
import { buildServer } from '../src/index.js';
import { AudioPreprocessClient } from '../src/audioPreprocessClient.js';
import { OrchestratorClient } from '../src/orchestratorClient.js';

// buildServer's JWT_SECRET is read once at module load from JWT_SIGNING_SECRET, defaulting
// to 'change-me' -- matches what server.test.ts's ticket-exchange test implicitly relies on
// too (neither sets the env var).
const JWT_SECRET = 'change-me';

function fakeAudioPreprocess() {
  const client = Object.create(AudioPreprocessClient.prototype) as AudioPreprocessClient;
  // First few frames "speech", then "silence" -- just enough of a shape to naturally arm
  // and then hangover-trigger the relay's segmentation. Exact VAD edge cases are
  // relay.test.ts's job; this integration test only proves index.ts's wiring end to end.
  let calls = 0;
  client.process = vi.fn(async (frame: Uint8Array) => ({ frame, speechDetected: calls++ < 4 }));
  return client;
}

function fakeOrchestrator() {
  const client = Object.create(OrchestratorClient.prototype) as OrchestratorClient;
  client.createSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
  client.postAudioTurn = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      transcript: 'is dr patel around',
      replyText: 'yes, until 5pm',
      // Empty audio -> speak()'s computed playback duration is 0ms, keeping this a fast,
      // real-timer test rather than needing to wait out a real clip length.
      audioBase64: Buffer.from(new Uint8Array(0)).toString('base64'),
      toolCallsExecuted: [],
    },
  });
  return client;
}

describe('gateway WS relay -- one happy-path utterance, end to end through real Fastify + a real WS client', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.close();
    await app?.close();
    delete process.env.MIN_UTTERANCE_SPEECH_MS;
    delete process.env.UTTERANCE_SILENCE_MS;
  });

  it('mic frames in -> TRANSCRIPT + STATE_CHANGE sequence out, via a real ticket-authenticated WS connection', async () => {
    // Fast, exact-frame-count segmentation for this test -- real-timer-based (not fake
    // timers, since this exercises actual Fastify/WS I/O), so keep it deterministic rather
    // than depending on the 700ms/300ms production defaults.
    process.env.MIN_UTTERANCE_SPEECH_MS = '20';
    process.env.UTTERANCE_SILENCE_MS = '20';

    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    app = buildServer({ audioPreprocess, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');
    const port = address.port;

    const token = jwt.sign({ sub: 'user-1', role: 'ROLE_RECEPTIONIST' }, JWT_SECRET);
    const ticketRes = await app.inject({ method: 'POST', url: '/session/ticket', headers: { authorization: `Bearer ${token}` } });
    expect(ticketRes.statusCode).toBe(200);
    const { ticket } = JSON.parse(ticketRes.body) as { ticket: string };

    const received: unknown[] = [];
    const binaryFramesReceived: number[] = [];

    await new Promise<void>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [`vita-ticket.${ticket}`]);
      ws.binaryType = 'nodebuffer';

      ws.on('open', () => {
        // fakeAudioPreprocess reports speech for the first 4 calls, silence from the 5th --
        // with MIN_UTTERANCE_SPEECH_MS/UTTERANCE_SILENCE_MS both 20ms (1 frame), that arms
        // on frame 1 and hangover-triggers on frame 5. Sending exactly 5 (not more) avoids
        // a second utterance racing to start once the relay flips back to LISTENING.
        for (let i = 0; i < 5; i++) {
          ws!.send(encodeBinaryFrame(BinaryFrameType.AUDIO_INPUT_PCM16, new Uint8Array([i])));
        }
      });

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          binaryFramesReceived.push(data.length);
        } else {
          const event = JSON.parse(data.toString()) as { event: string };
          received.push(event);
          if (event.event === 'STATE_CHANGE' && (event as { state: string }).state === 'LISTENING' && received.length > 1) {
            resolve();
          }
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('timed out waiting for the relay round trip')), 5000);
    });

    expect(orchestrator.createSession).toHaveBeenCalledWith({ sessionId: expect.any(String), userId: 'user-1', role: 'ROLE_RECEPTIONIST' });
    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1);
    expect(received).toEqual([
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'TRANSCRIPT', text: 'is dr patel around', is_final: true },
      { event: 'STATE_CHANGE', state: 'SPEAKING' },
      { event: 'STATE_CHANGE', state: 'LISTENING' },
    ]);
  });
});
