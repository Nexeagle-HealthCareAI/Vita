import Fastify from 'fastify';
import { Redis as IORedis, type Redis } from 'ioredis';
import { HmsClient } from '@vita/mcp-1hms';
import { SessionStore } from './session.js';
import { assertToolPermission, ForbiddenError, type Role } from './rbac.js';
import { recordAuditEvent } from './audit.js';
import { GroqClient } from './groq.js';
import { SarvamClient } from './sarvam.js';
import { runTurn } from './pipeline.js';

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function buildServer(
  redisClient?: Redis,
  clients?: { groq?: GroqClient; sarvam?: SarvamClient; hms?: HmsClient },
) {
  const redis = redisClient ?? new IORedis(REDIS_URL);
  const sessions = new SessionStore(redis);
  const groq = clients?.groq ?? new GroqClient(process.env.GROQ_API_KEY ?? '');
  const sarvam =
    clients?.sarvam ??
    new SarvamClient(
      process.env.SARVAM_API_KEY ?? '',
      process.env.SARVAM_STT_ENDPOINT ?? 'https://api.sarvam.ai/speech-to-text-streaming',
      process.env.SARVAM_TTS_ENDPOINT ?? 'https://api.sarvam.ai/text-to-speech',
    );
  const hms =
    clients?.hms ??
    new HmsClient(process.env.HMS_API_BASE_URL ?? 'http://localhost:5000', process.env.HMS_API_KEY ?? '');
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Internal endpoint the gateway relays to once a ticket is redeemed. See POST
  // /session/:id/turn below for the actual STT -> LLM -> MCP -> TTS pipeline
  // (pipeline.ts's runTurn) this session then gets used with.
  app.post('/session', async (req, reply) => {
    const body = req.body as { sessionId: string; userId: string; role: Role };
    const session = await sessions.create({
      sessionId: body.sessionId,
      userId: body.userId,
      role: body.role,
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: crypto.randomUUID(),
    });
    recordAuditEvent({
      ts: Date.now(),
      sessionId: session.sessionId,
      userId: session.userId,
      role: session.role,
      action: 'session_created',
      outcome: 'success',
    });
    return reply.send(session);
  });

  app.post('/session/:id/tool-call', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tool } = req.body as { tool: string };
    const session = await sessions.get(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });

    try {
      assertToolPermission(tool, session.role);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        recordAuditEvent({
          ts: Date.now(),
          sessionId: id,
          userId: session.userId,
          role: session.role,
          action: `tool_call:${tool}`,
          outcome: 'denied',
        });
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }

    recordAuditEvent({
      ts: Date.now(),
      sessionId: id,
      userId: session.userId,
      role: session.role,
      action: `tool_call:${tool}`,
      outcome: 'success',
    });
    // Direct "client names a tool itself" call -- kept separate from the LLM-driven
    // /session/:id/turn route below, which decides which tool (if any) to call.
    // TODO: also wire packages/rag retrieval here/in the turn pipeline once embeddings
    // + Qdrant ingestion exist (docs/BUILD_GUIDE.md §3.7).
    return reply.send({ status: 'accepted', tool });
  });

  // Runs one full conversation turn: transcript in, LLM (with tool-calling into 1HMS)
  // decides the reply, TTS speaks it. See pipeline.ts's runTurn for the STT->LLM->TTS
  // loop this wraps -- STT itself isn't called here since this route takes an
  // already-transcribed transcript (real-time audio streaming into this route is the
  // gateway relay + WS work described in docs/BUILD_GUIDE.md §3.3, not yet wired).
  app.post('/session/:id/turn', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { transcript } = req.body as { transcript: string };
    const session = await sessions.get(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!transcript || !transcript.trim()) {
      return reply.code(400).send({ error: 'transcript is required' });
    }

    const result = await runTurn({ session, transcript, groq, sarvam, hms });
    await sessions.update(id, { history: result.updatedHistory, turnState: 'IDLE' });

    return reply.send({
      replyText: result.replyText,
      audioBase64: Buffer.from(result.audio).toString('base64'),
      toolCallsExecuted: result.toolCallsExecuted,
    });
  });

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
