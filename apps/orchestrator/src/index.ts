import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { Redis as IORedis, type Redis } from 'ioredis';
import { QdrantClient } from '@qdrant/js-client-rest';
import { HmsClient } from '@vita/mcp-1hms';
import {
  HybridRetriever,
  LocalEmbedder,
  FAQ_DOCS,
  faqEmbedText,
  HOSPITAL_REFERENCE_DOCS,
  referenceEmbedText,
} from '@vita/rag';
import { SessionStore } from './session.js';
import { assertToolPermission, ForbiddenError, type Role } from './rbac.js';
import { recordAuditEvent, initAuditStore } from './audit.js';
import { GroqBrainProvider } from './brain/groq.js';
import type { BrainProvider } from './brain/types.js';
import { SarvamSttProvider } from './stt/sarvam.js';
import type { SttProvider, StreamingSttSession } from './stt/types.js';
import { SarvamTtsProvider } from './tts/sarvam.js';
import type { TtsProvider } from './tts/types.js';
import { runTurn } from './pipeline.js';
import { StreamSessionHandler } from './streamSession.js';
import { ConnectionOpenGate } from './connectionGate.js';
import { SarvamRealtimeSttSession, buildSarvamRealtimeUrl } from './stt/sarvamRealtime.js';

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function buildServer(
  redisClient?: Redis,
  clients?: {
    brain?: BrainProvider;
    stt?: SttProvider;
    tts?: TtsProvider;
    hms?: HmsClient;
    faqRetriever?: HybridRetriever;
    hospitalReferenceRetriever?: HybridRetriever;
    streamingSttSessionFactory?: () => StreamingSttSession;
    connectionGate?: ConnectionOpenGate;
  },
) {
  const redis = redisClient ?? new IORedis(REDIS_URL);
  const sessions = new SessionStore(redis);
  const brain =
    clients?.brain ?? new GroqBrainProvider(process.env.GROQ_API_KEY ?? '', undefined, process.env.GROQ_API_URL);
  // Independent vendor-agnostic bindings (brain/stt/tts folders) -- the routes/runTurn/
  // StreamSessionHandler below depend only on these interfaces, never on a concrete
  // vendor class, so swapping any one vendor never ripples past this composition root.
  const stt: SttProvider =
    clients?.stt ??
    new SarvamSttProvider(
      process.env.SARVAM_API_KEY ?? '',
      process.env.SARVAM_STT_ENDPOINT ?? 'https://api.sarvam.ai/speech-to-text-streaming',
    );
  const tts: TtsProvider =
    clients?.tts ??
    new SarvamTtsProvider(process.env.SARVAM_API_KEY ?? '', process.env.SARVAM_TTS_ENDPOINT ?? 'https://api.sarvam.ai/text-to-speech');
  const hms =
    clients?.hms ??
    new HmsClient(process.env.HMS_API_BASE_URL ?? 'http://localhost:5000', process.env.HMS_API_KEY ?? '');
  // FAQ + hospital-reference retrieval (search_vita_faq / search_hospital_reference tools
  // -- see tools.ts). Constructed synchronously and cheaply: QdrantClient's constructor
  // doesn't connect eagerly, LocalEmbedder's model load is lazy (first real embed()
  // call), and indexCorpus() over a few dozen docs total is in-memory BM25, no I/O -- so
  // this needs no async ripple into buildServer() or the many existing tests that call it
  // synchronously. Requires `pnpm --filter @vita/rag ingest` to have populated Qdrant's
  // dense vectors at least once (see that package's README/ingest.ts) -- this constructor
  // doesn't do that itself.
  //
  // qdrant/embedder are shared across both retrievers below rather than one each -- a
  // second QdrantClient is harmless, but a second LocalEmbedder would mean loading the
  // same WASM model twice (its load is lazy but cached PER INSTANCE): doubled memory and
  // a second cold-start latency spike, for zero benefit.
  const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined,
    // No real Qdrant is reachable in most test/CI runs (this default is only ever
    // actually hit in tests that don't override clients.faqRetriever/
    // clients.hospitalReferenceRetriever) -- skips a background version-compatibility
    // check that otherwise just console.warns.
    checkCompatibility: false,
  });
  const embedder = new LocalEmbedder();
  const faqRetriever =
    clients?.faqRetriever ??
    (() => {
      const r = new HybridRetriever(qdrant, process.env.QDRANT_FAQ_COLLECTION ?? 'vita_faq', embedder.embed);
      r.indexCorpus(FAQ_DOCS.map((d) => ({ id: d.id, text: faqEmbedText(d) })));
      return r;
    })();
  const hospitalReferenceRetriever =
    clients?.hospitalReferenceRetriever ??
    (() => {
      const r = new HybridRetriever(
        qdrant,
        process.env.QDRANT_HOSPITAL_REFERENCE_COLLECTION ?? 'vita_hospital_reference',
        embedder.embed,
      );
      r.indexCorpus(HOSPITAL_REFERENCE_DOCS.map((d) => ({ id: d.id, text: referenceEmbedText(d) })));
      return r;
    })();
  // Real-time streaming STT (apps/gateway/src/streamingTurnBackend.ts's counterpart) -- one
  // Sarvam realtime WS session per call, gated by connectionGate to stagger connection-open
  // bursts (Sarvam's rate limiter is burst-sensitive, not a static ceiling -- see
  // connectionGate.ts). The gateway's STREAMING_STT_ENABLED is the single source of truth for
  // whether this ever gets exercised; this route is harmless to register unconditionally.
  const streamingSttSessionFactory =
    clients?.streamingSttSessionFactory ??
    (() =>
      new SarvamRealtimeSttSession(
        buildSarvamRealtimeUrl({
          baseUrl: process.env.SARVAM_STT_REALTIME_URL ?? 'wss://api.sarvam.ai/speech-to-text-realtime/ws',
          languageCode: process.env.SARVAM_STT_LANGUAGE_CODE ?? 'en-IN',
          streamType: process.env.SARVAM_STT_STREAM_TYPE ?? 'fast',
        }),
        process.env.SARVAM_API_KEY ?? '',
      ));
  const connectionGate =
    clients?.connectionGate ??
    new ConnectionOpenGate(
      Number(process.env.SARVAM_CONNECT_BURST_CAPACITY ?? 3),
      Number(process.env.SARVAM_CONNECT_REFILL_MS ?? 250),
    );
  // bodyLimit default (1MB) comfortably covers a raw-audio turn (worst case ~625KB at the
  // gateway relay's 20s max-utterance cap) but is bumped for headroom -- see /turn/audio below.
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  app.register(websocketPlugin);

  // The gateway relay posts one utterance's raw PCM16 audio per turn (see
  // /session/:id/turn/audio below) -- Fastify has no default parser for this content type
  // and throws FST_ERR_CTP_INVALID_MEDIA_TYPE without one registered.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, payload, done) => {
    done(null, payload);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Internal endpoint the gateway relays to once a ticket is redeemed. See POST
  // /session/:id/turn below for the actual STT -> LLM -> MCP -> TTS pipeline
  // (pipeline.ts's runTurn) this session then gets used with.
  app.post('/session', async (req, reply) => {
    const body = req.body as { sessionId: string; userId: string; role: Role; consentGiven?: boolean };
    // The one authoritative choke point for the DPDPA consent gate (docs/BUILD_GUIDE.md
    // §6) -- everything upstream (web-sdk, gateway ticket/relay) is a passthrough. A
    // resumed session never re-proves consent here since /session/:id/resume is a
    // separate route that only reattaches to a session that already passed this check.
    if (body.consentGiven !== true) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: body.sessionId,
        userId: body.userId,
        role: body.role,
        action: 'consent_missing',
        outcome: 'denied',
      });
      return reply.code(400).send({ error: 'consent required before a session can start' });
    }
    recordAuditEvent({
      ts: Date.now(),
      sessionId: body.sessionId,
      userId: body.userId,
      role: body.role,
      action: 'consent_given',
      outcome: 'success',
    });
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

  // Reattaches a dropped WS connection to its existing session instead of starting a
  // fresh one -- see the gateway's ConnectionRelay.start()'s resumeInfo path, which posts
  // here before falling back to POST /session above on any failure. Every failure case
  // (unknown session, wrong token, wrong userId, missing fields) returns the SAME 404
  // shape deliberately -- distinguishing them would let a caller use the response as an
  // oracle to enumerate live session ids or narrow a token-guessing attack, mirroring how
  // the gateway's redeemTicket() already collapses its own failure modes into one null.
  app.post('/session/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resumeToken?: string; userId?: string };

    if (!body?.resumeToken || !body?.userId) {
      return reply.code(404).send({ error: 'session not found' });
    }

    const resumed = await sessions.resume(id, body.resumeToken);
    if (!resumed || resumed.userId !== body.userId) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: id,
        userId: body.userId,
        role: resumed?.role ?? 'ROLE_RECEPTIONIST',
        action: 'session_resume',
        outcome: 'denied',
      });
      return reply.code(404).send({ error: 'session not found' });
    }

    // Rotate only now that the requester is authorized -- see rotateResumeToken()'s doc
    // comment for why this must not happen inside resume() itself.
    const rotated = await sessions.rotateResumeToken(id);
    if (!rotated) {
      return reply.code(404).send({ error: 'session not found' });
    }

    recordAuditEvent({
      ts: Date.now(),
      sessionId: id,
      userId: rotated.userId,
      role: rotated.role,
      action: 'session_resume',
      outcome: 'success',
    });

    return reply.send({ sessionId: rotated.sessionId, resumeToken: rotated.resumeToken });
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
    // /session/:id/turn route below, which decides which tool (if any) to call. This
    // route doesn't actually dispatch to executeTool for any of the 3 HMS tools either
    // (RBAC-check + audit only, then a bare acknowledgement) -- that gap predates and is
    // unrelated to search_vita_faq/RAG, which is wired into the LLM-driven /turn route's
    // pipeline.ts instead. Not addressed here.
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

    const result = await runTurn({ session, transcript, brain, tts, hms, faqRetriever, hospitalReferenceRetriever });
    await sessions.update(id, { history: result.updatedHistory, turnState: 'IDLE' });

    return reply.send({
      replyText: result.replyText,
      audioBase64: Buffer.from(result.audio).toString('base64'),
      toolCallsExecuted: result.toolCallsExecuted,
    });
  });

  // The gateway relay's audio-input counterpart to /session/:id/turn above -- it segments a
  // caller's speech into utterances itself (apps/gateway/src/relay.ts) and posts the raw PCM16
  // bytes here instead of an already-transcribed string. This route just adds an STT step in
  // front of the exact same runTurn used by the text-transcript route.
  app.post('/session/:id/turn/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sessions.get(id);
    if (!session) {
      return reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'session not found', recoverable: false } });
    }

    const audio = new Uint8Array(req.body as Buffer);

    let transcript: string;
    try {
      transcript = (await stt.transcribe(audio)).text;
    } catch (err) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: id,
        userId: session.userId,
        role: session.role,
        action: 'stt',
        outcome: 'error',
      });
      return reply.code(502).send({ error: { code: 'STT_FAILED', message: errMessage(err), recoverable: true } });
    }

    if (!transcript.trim()) {
      // Soft no-op, not an error: the gateway's VAD armed an utterance but Sarvam heard no
      // words (cough/breath/noise). Mirrors /session/:id/turn's empty-transcript rejection in
      // spirit, but this is an expected/normal outcome here, not a client mistake -- don't
      // waste a Groq round trip on it.
      recordAuditEvent({
        ts: Date.now(),
        sessionId: id,
        userId: session.userId,
        role: session.role,
        action: 'stt_empty',
        outcome: 'success',
      });
      return reply.send({ transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [] });
    }

    let result;
    try {
      result = await runTurn({ session, transcript, brain, tts, hms, faqRetriever, hospitalReferenceRetriever });
    } catch (err) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: id,
        userId: session.userId,
        role: session.role,
        action: 'turn',
        outcome: 'error',
      });
      return reply.code(502).send({ error: { code: 'TURN_FAILED', message: errMessage(err), recoverable: true } });
    }

    await sessions.update(id, { history: result.updatedHistory, turnState: 'IDLE' });

    return reply.send({
      transcript,
      replyText: result.replyText,
      audioBase64: Buffer.from(result.audio).toString('base64'),
      toolCallsExecuted: result.toolCallsExecuted,
    });
  });

  // Real-time counterpart to /session/:id/turn/audio above -- the gateway's
  // StreamingTurnBackend opens this once per call (not per utterance) and forwards frames
  // continuously instead of buffering a whole utterance first. See streamSession.ts for the
  // per-call orchestration this thin route delegates to.
  app.register(async (instance) => {
    instance.get('/session/:id/stream', { websocket: true }, (socket, req) => {
      const { id } = req.params as { id: string };

      void (async () => {
        const session = await sessions.get(id);
        if (!session) {
          socket.close(4004, 'session not found');
          return;
        }

        const handler = new StreamSessionHandler(id, socket, {
          sessions,
          brain,
          tts,
          hms,
          faqRetriever,
          hospitalReferenceRetriever,
          streamingSttSessionFactory,
          connectionGate,
          connectTimeoutMs: Number(process.env.SARVAM_CONNECT_TIMEOUT_MS ?? 1800),
          gateMaxWaitMs: Number(process.env.SARVAM_CONNECT_GATE_MAX_WAIT_MS ?? 1000),
          log: req.log,
        });

        socket.on('message', (data: Buffer, isBinary: boolean) => handler.handleMessage(data, isBinary));
        socket.on('close', () => handler.onClose());

        await handler.init();
      })();
    });
  });

  return app;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  // Fire-and-forget: schema creation + the retention purge loop for the durable audit
  // store (docs/BUILD_GUIDE.md §6) -- a no-op if DATABASE_URL isn't configured, so this
  // never blocks/fails startup. Deliberately not called from buildServer() itself, which
  // every test also calls -- keeps a real Postgres connection out of the test suite.
  void initAuditStore();
  app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
