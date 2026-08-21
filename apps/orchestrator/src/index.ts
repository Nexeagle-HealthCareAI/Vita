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
import { SessionStore, type DialogueSession } from './session.js';
import { assertToolPermission, ForbiddenError, isToolAllowed, derivePersona } from './rbac.js';
import { resolveSessionPermissions } from './permissions.js';
import { recordAuditEvent, initAuditStore } from './audit.js';
import { GroqBrainProvider } from './brain/groq.js';
import type { BrainProvider } from './brain/types.js';
import { SarvamSttProvider } from './stt/sarvam.js';
import type { SttProvider, StreamingSttSession } from './stt/types.js';
import { SarvamTtsProvider } from './tts/sarvam.js';
import type { TtsProvider } from './tts/types.js';
import { runTurn, type RunTurnResult } from './pipeline.js';
import { StreamSessionHandler } from './streamSession.js';
import { ConnectionOpenGate } from './connectionGate.js';
import { SarvamRealtimeSttSession, buildSarvamRealtimeUrl } from './stt/sarvamRealtime.js';
import { fetchRosterText } from './doctorRoster.js';

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** Header/query param a gateway uses to declare which session generation its connection
 * belongs to -- see session.ts's DialogueSession.epoch. */
export const SESSION_EPOCH_HEADER = 'x-vita-session-epoch';

/**
 * Whether to reject a turn whose declared epoch is stale at ROUTE ENTRY (cheap -- before
 * any Groq/TTS spend), on top of session.ts's write-time fence, which is the real
 * correctness backstop and is always on.
 *
 * Ships dark (`=== 'true'`, default OFF), matching the gateway's
 * PROTOCOL_VERSION_ENFORCEMENT_ENABLED rather than SESSION_RESUME_ENABLED's `!== 'false'`:
 * a misfire here kills live calls, so it gets the conservative default. Read fresh at the
 * point of use so tests can toggle it per-case.
 *
 * Note this is only ever consulted when the caller actually SENT an epoch. A request with
 * no epoch is always accepted regardless -- required for rolling deploys and for any
 * gateway build predating this contract.
 */
function epochEnforcementEnabled(): boolean {
  return process.env.SESSION_EPOCH_ENFORCEMENT_ENABLED === 'true';
}

/** Parses a declared epoch off a request. Returns null for absent/garbage -- both mean
 * "caller didn't declare one", which is never a rejection. */
function declaredEpoch(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

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
  const HOSPITAL_ID = process.env.HOSPITAL_ID;
  const hms =
    clients?.hms ??
    new HmsClient(process.env.HMS_API_BASE_URL ?? 'http://localhost:5000', process.env.HMS_API_KEY ?? '');

  // Instant single-env-var rollback, independent of HOSPITAL_ID itself (which other
  // future features may reuse) -- matches SESSION_RESUME_ENABLED's `!== 'false'` idiom:
  // this feature's failure mode is fully benign (an unresolved/failed fetch just leaves
  // the system prompt exactly as it was before this feature existed), so default ON is
  // correct, same reasoning gateway/src/index.ts's sessionResumeEnabled() documents.
  const DOCTOR_ROSTER_ENABLED = process.env.DOCTOR_ROSTER_ENABLED !== 'false';
  // Doctor-roster prefetch for phonetic-name-correction context (see doctorRoster.ts) --
  // kicked off HERE, once per process, but deliberately NOT awaited: buildServer() itself
  // must stay synchronous (many existing tests call it without `await`, same reason the
  // QdrantClient/HybridRetriever construction below is sync). Every route below awaits
  // this SAME promise lazily, right before it's needed -- so a slow/failed fetch is paid
  // at most once per process, never once per request, and buildSystemPrompt only ever
  // sees an already-resolved string or undefined.
  const rosterTextPromise: Promise<string | undefined> =
    HOSPITAL_ID && DOCTOR_ROSTER_ENABLED ? fetchRosterText(hms, HOSPITAL_ID) : Promise.resolve(undefined);

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

  // Checks the one dependency this process cannot function at all without -- previously
  // an unconditional {status:'ok'}, which meant a broken/unreachable Redis (every
  // session read/write fails) still reported healthy to deploy.yml's health-check gate
  // and any future readiness probe.
  app.get('/healthz', async (_req, reply) => {
    try {
      await redis.ping();
    } catch (err) {
      return reply.code(503).send({ status: 'degraded', redis: 'unreachable', error: err instanceof Error ? err.message : String(err) });
    }
    return { status: 'ok' };
  });

  // Internal endpoint the gateway relays to once a ticket is redeemed. See POST
  // /session/:id/turn below for the actual STT -> LLM -> MCP -> TTS pipeline
  // (pipeline.ts's runTurn) this session then gets used with.
  app.post('/session', async (req, reply) => {
    const body = req.body as {
      sessionId: string;
      userId: string;
      consentGiven?: boolean;
      /** Forwarded from the calling staff member's own easyHMSWeb session (see
       * apps/gateway/src/ticket.ts's SessionClaims) -- both optional, see
       * session.ts's DialogueSession doc comment for what an absent pair means. No `role`
       * field anymore -- persona is derived server-side from real resolved permissions
       * (see rbac.ts's Persona doc comment), never trusted from the client. */
      hospitalId?: string;
      hmsAccessToken?: string;
    };
    // The one authoritative choke point for the DPDPA consent gate (docs/BUILD_GUIDE.md
    // §6) -- everything upstream (web-sdk, gateway ticket/relay) is a passthrough. A
    // resumed session never re-proves consent here since /session/:id/resume is a
    // separate route that only reattaches to a session that already passed this check.
    // Checked FIRST, before ever resolving real permissions -- a real GET
    // user/permissions call against easyHMSAPI, per permissions.ts. Consent is free (no
    // I/O); a client (or bot) hammering this route without consent previously still
    // drove one real backend call per request even though no session would ever be
    // created either way.
    if (body.consentGiven !== true) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: body.sessionId,
        userId: body.userId,
        // Permissions were never resolved -- consent was denied before that would
        // matter for anything but this audit line's cosmetic persona field.
        role: 'ROLE_RECEPTIONIST',
        action: 'consent_missing',
        outcome: 'denied',
      });
      return reply.code(400).send({ error: 'consent required before a session can start' });
    }
    const { permissions } = await resolveSessionPermissions(hms, body.userId, body.hmsAccessToken);
    const persona = derivePersona(permissions);
    recordAuditEvent({
      ts: Date.now(),
      sessionId: body.sessionId,
      userId: body.userId,
      role: persona,
      action: 'consent_given',
      outcome: 'success',
    });
    const session = await sessions.create({
      sessionId: body.sessionId,
      userId: body.userId,
      persona,
      permissions,
      turnState: 'IDLE',
      slots: {},
      history: [],
      resumeToken: crypto.randomUUID(),
      // Starts at 1, never 0/undefined, so a session this code wrote is distinguishable
      // from one persisted before the field existed (see DialogueSession.epoch).
      epoch: 1,
      hospitalId: body.hospitalId,
      hmsAccessToken: body.hmsAccessToken,
    });
    recordAuditEvent({
      ts: Date.now(),
      sessionId: session.sessionId,
      userId: session.userId,
      role: session.persona,
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
        role: resumed?.persona ?? 'ROLE_RECEPTIONIST',
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
      role: rotated.persona,
      action: 'session_resume',
      outcome: 'success',
    });

    // epoch returned so the resuming gateway can fence its own later turns against it
    // (see B2's x-vita-session-epoch); harmless for a caller that ignores it.
    return reply.send({ sessionId: rotated.sessionId, resumeToken: rotated.resumeToken, epoch: rotated.epoch ?? 0 });
  });

  app.post('/session/:id/tool-call', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tool } = req.body as { tool: string };
    const session = await sessions.get(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });

    try {
      assertToolPermission(tool, session.permissions);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        recordAuditEvent({
          ts: Date.now(),
          sessionId: id,
          userId: session.userId,
          role: session.persona,
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
      role: session.persona,
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

    const result = await runTurn({ session, transcript, brain, tts, hms, faqRetriever, hospitalReferenceRetriever, rosterText: await rosterTextPromise });
    const formFields = computeFormFields(session, result);
    // expectedEpoch: the generation this turn STARTED against. runTurn takes seconds
    // (Groq + tool rounds + TTS), and a resume landing in that window supersedes this
    // connection -- writing our stale snapshot back would silently wipe whatever the new
    // connection has completed since. See session.ts's update() doc comment.
    const persisted = await sessions.update(
      id,
      { history: result.updatedHistory, slots: result.updatedSlots, turnState: 'IDLE' },
      { expectedEpoch: session.epoch ?? 0 },
    );
    if (!persisted) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.persona,
        action: 'turn_superseded',
        outcome: 'denied',
      });
      return reply
        .code(502)
        .send({ error: { code: 'SESSION_SUPERSEDED', message: 'this session was resumed on a newer connection', recoverable: false } });
    }
    if (Object.keys(formFields).length > 0) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.persona,
        action: 'form_autofill_push',
        outcome: 'success',
      });
    }

    return reply.send({
      replyText: result.replyText,
      audioBase64: Buffer.from(result.audio).toString('base64'),
      toolCallsExecuted: result.toolCallsExecuted,
      formFields: Object.keys(formFields).length > 0 ? formFields : null,
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

    // Cheap entry-side fence: reject a connection that's already been superseded BEFORE
    // spending a Groq/Sarvam round trip on it. Absent epoch => always accepted (rolling
    // deploys, older gateway builds). session.ts's write-time fence is the real backstop
    // and stays on regardless -- this only saves work.
    const claimedEpoch = declaredEpoch(req.headers[SESSION_EPOCH_HEADER]);
    if (epochEnforcementEnabled() && claimedEpoch !== null && claimedEpoch !== (session.epoch ?? 0)) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: id,
        userId: session.userId,
        role: session.persona,
        action: 'turn_superseded',
        outcome: 'denied',
      });
      return reply
        .code(502)
        .send({ error: { code: 'SESSION_SUPERSEDED', message: 'this session was resumed on a newer connection', recoverable: false } });
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
        role: session.persona,
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
        role: session.persona,
        action: 'stt_empty',
        outcome: 'success',
      });
      return reply.send({ transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [], formFields: null });
    }

    let result;
    try {
      result = await runTurn({ session, transcript, brain, tts, hms, faqRetriever, hospitalReferenceRetriever, rosterText: await rosterTextPromise });
    } catch (err) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: id,
        userId: session.userId,
        role: session.persona,
        action: 'turn',
        outcome: 'error',
      });
      return reply.code(502).send({ error: { code: 'TURN_FAILED', message: errMessage(err), recoverable: true } });
    }

    const formFields = computeFormFields(session, result);
    // See the /turn route above for why the write is fenced on the epoch this turn started
    // against.
    const persisted = await sessions.update(
      id,
      { history: result.updatedHistory, slots: result.updatedSlots, turnState: 'IDLE' },
      { expectedEpoch: session.epoch ?? 0 },
    );
    if (!persisted) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: id,
        userId: session.userId,
        role: session.persona,
        action: 'turn_superseded',
        outcome: 'denied',
      });
      return reply
        .code(502)
        .send({ error: { code: 'SESSION_SUPERSEDED', message: 'this session was resumed on a newer connection', recoverable: false } });
    }
    if (Object.keys(formFields).length > 0) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.persona,
        action: 'form_autofill_push',
        outcome: 'success',
      });
    }

    return reply.send({
      transcript,
      replyText: result.replyText,
      audioBase64: Buffer.from(result.audio).toString('base64'),
      toolCallsExecuted: result.toolCallsExecuted,
      formFields: Object.keys(formFields).length > 0 ? formFields : null,
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
        try {
          const session = await sessions.get(id);
          if (!session) {
            socket.close(4004, 'session not found');
            return;
          }

          // Entry-side fence, the stream twin of /turn/audio's header check. A WS upgrade
          // has no body, so the epoch rides the query string -- which is exactly why the
          // fence value is a bare integer and not resumeToken: Fastify's logger writes
          // every request URL to stdout.
          const claimedEpoch = declaredEpoch((req.query as Record<string, string> | undefined)?.epoch);
          if (epochEnforcementEnabled() && claimedEpoch !== null && claimedEpoch !== (session.epoch ?? 0)) {
            recordAuditEvent({
              ts: Date.now(),
              sessionId: id,
              userId: session.userId,
              role: session.persona,
              action: 'turn_superseded',
              outcome: 'denied',
            });
            socket.close(4004, 'session superseded');
            return;
          }

          const handler = new StreamSessionHandler(id, socket, {
            sessions,
            brain,
            tts,
            hms,
            faqRetriever,
            hospitalReferenceRetriever,
            rosterTextPromise,
            streamingSttSessionFactory,
            connectionGate,
            connectTimeoutMs: Number(process.env.SARVAM_CONNECT_TIMEOUT_MS ?? 1800),
            gateMaxWaitMs: Number(process.env.SARVAM_CONNECT_GATE_MAX_WAIT_MS ?? 1000),
            log: req.log,
          });

          socket.on('message', (data: Buffer, isBinary: boolean) => handler.handleMessage(data, isBinary));
          socket.on('close', () => handler.onClose());

          await handler.init();
        } catch (err) {
          // This whole block runs from a `void`-fired async IIFE with no caller awaiting
          // it -- an uncaught rejection here (e.g. a genuine Redis error from sessions.get,
          // not just a decode failure, which SessionStore.get() now handles itself) would
          // otherwise crash the entire orchestrator process, dropping every other
          // concurrent call on this instance, not just this one connection.
          req.log.error({ err, sessionId: id }, 'streaming session bootstrap failed');
          socket.close(1011, 'internal error');
        }
      })();
    });
  });

  return app;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Which of this turn's slot changes (if any) are worth pushing to the client as
 * UI_FORM_AUTOFILL -- gated HERE, orchestrator-side, as the authoritative check (every
 * other authorization decision in this codebase, assertToolPermission, already lives
 * orchestrator-side too). Gated on the REAL permission that governs booking
 * (isToolAllowed('book_appointment', ...)), never on persona -- persona is a cosmetic
 * UX bucket (see rbac.ts's Persona doc comment) that would otherwise let a Nurse,
 * Accountant, or any hospital's custom role without doc_board fall into the "receptionist"
 * bucket and get this PII-shaped autofill data pushed regardless of whether it actually
 * holds appointment_scheduler/appointment_booking. A session without that permission never
 * sends/audits a push at all -- gating only downstream (the gateway's relay.ts, or
 * web-sdk's client-side check) would mean an audit record claims a push happened that was
 * silently dropped, and would ship PII-shaped data over the internal WS for no reason.
 * (result.formFieldsThisTurn is pipeline.ts's own high-water-mark diff -- see
 * RunTurnResult's doc comment for why it's not simply session.slots vs. updatedSlots.) */
function computeFormFields(session: DialogueSession, result: RunTurnResult): Record<string, unknown> {
  return isToolAllowed('book_appointment', session.permissions) ? result.formFieldsThisTurn : {};
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  if (!process.env.SESSION_ENCRYPTION_KEY) {
    // Loud, deliberate startup-time visibility (not a hard refusal to start -- this
    // environment's real SESSION_ENCRYPTION_KEY/HOSPITAL_ID state isn't something this
    // change can safely assume, and a startup crash on a live service is a much larger
    // blast radius than a warning). A session can carry a real, live forwarded staff
    // bearer JWT (DialogueSession.hmsAccessToken, see session.ts) the moment any hospital
    // staff member's ticket includes one -- there's no separate feature flag gating that,
    // so an unset key here means that credential sits in plaintext in Redis for up to
    // SESSION_TTL_SECONDS in EVERY environment, not just ones that opted into a specific
    // feature. See .env.example's SESSION_ENCRYPTION_KEY comment.
    app.log.warn(
      'SESSION_ENCRYPTION_KEY is not set -- session data, including any forwarded staff bearer JWT, ' +
        'is stored in PLAINTEXT in Redis for up to SESSION_TTL_SECONDS. Set SESSION_ENCRYPTION_KEY in ' +
        'every environment where staff-auth tools (e.g. mark_appointment_arrived) may be used.',
    );
  }
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
