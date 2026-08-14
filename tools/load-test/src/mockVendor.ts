import Fastify, { type FastifyInstance } from 'fastify';

/**
 * In-process stub for Sarvam (STT/TTS) and Groq (chat completions) -- NOT a 4th spawned
 * subprocess, since it's harness-owned test scaffolding, not one of the real services
 * under test (apps/gateway, apps/orchestrator, apps/audio-preprocess). Matches the real
 * request/response shapes read directly from apps/orchestrator/src/sarvam.ts and
 * groq.ts, but returns fast, deterministic, scripted responses -- it exists purely to
 * unblock throughput/concurrency measurement of the REAL internal pipeline for free,
 * not to validate vendor correctness (already covered by apps/orchestrator's own
 * unit-test fakes) or exercise tool-calling (see the Groq route's deliberate
 * no-tool_calls response -- 1HMS is never invoked by this harness).
 */

const CANNED_TRANSCRIPT = 'is doctor patel available this afternoon';
const CANNED_REPLY_TEXT = 'Yes, Doctor Patel has availability this afternoon.';

/** ~800ms of near-silent 16kHz mono PCM16 -- just enough for the real pipeline (relay's
 * speak() chunking, playback-duration math) to have something real to chunk and time,
 * without needing a real TTS call. Computed once at stub construction, not per request. */
function fakeReplyAudioBase64(): string {
  const sampleRate = 16000;
  const durationMs = 800;
  const samples = new Int16Array((sampleRate * durationMs) / 1000);
  // A quiet 220Hz tone rather than pure silence -- distinguishable from a bug that
  // returns an all-zero buffer, in case that ever needs debugging from a metrics dump.
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(500 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  }
  return Buffer.from(samples.buffer).toString('base64');
}

export interface MockVendorConfig {
  sttDelayMs?: number;
}

export function buildMockVendor(config: MockVendorConfig = {}): FastifyInstance {
  const sttDelayMs = config.sttDelayMs ?? 200;
  const replyAudioBase64 = fakeReplyAudioBase64();

  const app = Fastify({ logger: false });

  // Sarvam's real STT endpoint takes multipart/form-data (see sarvam.ts's transcribe())
  // -- Fastify has no default parser for it, and this stub deliberately never parses
  // the body anyway (vendor correctness isn't what this harness measures), so just
  // accept and discard whatever bytes arrive.
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_req, _payload, done) => {
    done(null, undefined);
  });

  app.post('/sarvam/stt', async (_req, reply) => {
    if (sttDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sttDelayMs));
    return reply.send({ transcript: CANNED_TRANSCRIPT });
  });

  app.post('/sarvam/tts', async (_req, reply) => {
    return reply.send({ audios: [replyAudioBase64] });
  });

  app.post('/groq/chat/completions', async (_req, reply) => {
    return reply.send({
      choices: [
        {
          message: {
            content: CANNED_REPLY_TEXT,
            // Deliberately no tool_calls -- keeps 1HMS/HmsClient entirely out of scope
            // for this harness (see the module doc comment above).
            tool_calls: undefined,
          },
        },
      ],
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
