import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { BinaryFrameType, decodeBinaryFrame } from '@vita/protocol';
import { redeemTicket, verifyJwtAndIssueTicket, type ResumeIntent } from './ticket.js';
import { AudioPreprocessClient } from './audioPreprocessClient.js';
import { OrchestratorClient } from './orchestratorClient.js';
import { ConnectionRelay, type RelayConfig } from './relay.js';
import { RelaySessionRegistry } from './relaySessionRegistry.js';
import type { TurnBackendFactory } from './turnBackend.js';
import { DefaultTurnBackendFactory, OrchestratorStreamClient } from './streamingTurnBackend.js';

const JWT_SECRET = process.env.JWT_SIGNING_SECRET ?? 'change-me';
const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const TICKET_PROTOCOL_PREFIXES = ['vita-ticket.', 'tera-ticket.'] as const;

// Instant single-env-var rollback lever for SESSION_RESUME (default ON) -- not a
// ship-dark gate like STREAMING_STT_ENABLED, since resume adds no new external
// dependency and every failure path already degrades to today's proven behavior. Exists
// because this change's blast radius spans protocol+orchestrator+gateway+web-sdk.
// Matches BARGE_IN_ENABLED's existing `!== 'false'` idiom. Read fresh at the point of use
// (not a module-level const) for the same reason relayConfigFromEnv() is -- so tests can
// override it via process.env before constructing the server.
function sessionResumeEnabled(): boolean {
  return process.env.SESSION_RESUME_ENABLED !== 'false';
}

// Real-time streaming STT is opt-in and OFF by default (Phase 1) -- see the streaming
// STT plan's rollout section. Ships dark until validated against a real Sarvam key in
// staging; every call falls back to the existing, already-proven batch path regardless.
function deriveWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

// Read fresh per buildServer() call (not at module top-level) so tests can override via
// process.env before constructing the server, same as AUDIO_PREPROCESS_URL/
// ORCHESTRATOR_INTERNAL_URL below. All optional -- an unset var leaves ConnectionRelay's
// own default for that field untouched.
function relayConfigFromEnv(): Partial<RelayConfig> {
  const config: Partial<RelayConfig> = {};
  if (process.env.UTTERANCE_SILENCE_MS) config.silenceHangoverMs = Number(process.env.UTTERANCE_SILENCE_MS);
  if (process.env.MIN_UTTERANCE_SPEECH_MS) config.minUtteranceSpeechMs = Number(process.env.MIN_UTTERANCE_SPEECH_MS);
  if (process.env.MAX_UTTERANCE_MS) config.maxUtteranceMs = Number(process.env.MAX_UTTERANCE_MS);
  if (process.env.BARGE_IN_ENABLED) config.bargeInEnabled = process.env.BARGE_IN_ENABLED !== 'false';
  if (process.env.BARGE_IN_GRACE_MS) config.bargeInGraceMs = Number(process.env.BARGE_IN_GRACE_MS);
  return config;
}

export function extractTicketProtocol(protocols: string[]): string | undefined {
  const ticketProtocol = protocols.find((protocol) =>
    TICKET_PROTOCOL_PREFIXES.some((prefix) => protocol.startsWith(prefix)),
  );
  if (!ticketProtocol) return undefined;

  const prefix = TICKET_PROTOCOL_PREFIXES.find((candidate) => ticketProtocol.startsWith(candidate));
  return prefix ? ticketProtocol.slice(prefix.length) : undefined;
}

export function buildServer(deps?: {
  audioPreprocess?: AudioPreprocessClient;
  orchestrator?: OrchestratorClient;
  backendFactory?: TurnBackendFactory;
  relaySessionRegistry?: RelaySessionRegistry;
}) {
  const orchestratorHttpUrl = process.env.ORCHESTRATOR_INTERNAL_URL ?? 'http://localhost:8081';
  const audioPreprocess =
    deps?.audioPreprocess ?? new AudioPreprocessClient(process.env.AUDIO_PREPROCESS_URL ?? 'http://localhost:8090');
  const orchestrator = deps?.orchestrator ?? new OrchestratorClient(orchestratorHttpUrl);
  const backendFactory =
    deps?.backendFactory ??
    new DefaultTurnBackendFactory(orchestrator, () => new OrchestratorStreamClient(deriveWsUrl(orchestratorHttpUrl)), {
      streamingEnabled: process.env.STREAMING_STT_ENABLED === 'true',
      connectTimeoutMs: Number(process.env.STREAM_CONNECT_TIMEOUT_MS ?? 3000),
    });
  const relaySessionRegistry = deps?.relaySessionRegistry ?? new RelaySessionRegistry();
  const relayConfig = relayConfigFromEnv();

  const app = Fastify({ logger: true });
  app.register(websocketPlugin);

  // Step 1: HTTPS ticket exchange. The long-lived JWT is verified here and
  // never leaves this request — the client gets back a short-lived,
  // single-use ticket to redeem on the WS upgrade. A reconnecting client may also carry
  // a resume pair in this same HTTPS-protected body -- see ticket.ts's ResumeIntent and
  // relay.ts's start(resumeInfo) for where it goes next. Real validation of the pair
  // happens only later, at the orchestrator's POST /session/:id/resume.
  app.post('/session/ticket', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing bearer token' });
    }
    const body = (req.body ?? {}) as { resumeSessionId?: string; resumeToken?: string };
    const resumeIntent: ResumeIntent | undefined =
      sessionResumeEnabled() && body.resumeSessionId && body.resumeToken
        ? { sessionId: body.resumeSessionId, resumeToken: body.resumeToken }
        : undefined;
    try {
      const ticket = verifyJwtAndIssueTicket(auth.slice('Bearer '.length), JWT_SECRET, resumeIntent);
      return reply.send({ ticket });
    } catch {
      return reply.code(401).send({ error: 'invalid token' });
    }
  });

  // Step 2: WS upgrade. Ticket is passed as a subprotocol
  // (`vita-ticket.<ticket>`; legacy `tera-ticket.<ticket>` is also accepted),
  // redeemed exactly once, and the resulting
  // claims (identity + role) are what everything downstream trusts —
  // NOT anything else the client sends on this connection.
  app.register(async (instance) => {
    instance.get('/v1/stream', { websocket: true }, (socket, req) => {
      const protocols = req.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim()) ?? [];
      const ticket = extractTicketProtocol(protocols);

      const redeemed = ticket ? redeemTicket(ticket) : null;
      if (!redeemed) {
        socket.close(4001, 'invalid or expired ticket');
        return;
      }
      const { claims, resumeIntent } = redeemed;

      req.log.info({ sub: claims.sub, role: claims.role, resuming: !!resumeIntent }, 'session established');

      if (resumeIntent) {
        // Force-close any relay this process still has live for the target sessionId
        // BEFORE the new relay starts -- two relays must never concurrently drive one
        // orchestrator session on this process. Same-process-only scope, see
        // RelaySessionRegistry's doc comment.
        relaySessionRegistry.evict(resumeIntent.sessionId);
      }

      let socketClosed = false;

      // apps/gateway/src/relay.ts owns VAD-based utterance segmentation and the
      // LISTENING/PROCESSING/SPEAKING lifecycle for this connection; it calls out to
      // audio-preprocess per frame regardless, and to the orchestrator via whichever
      // TurnBackend backendFactory hands it -- real-time streaming over a persistent WS
      // when STREAMING_STT_ENABLED, else the batch HTTP path, decided once per call.
      const relay = new ConnectionRelay(
        {
          audioPreprocess,
          orchestrator,
          backendFactory,
          claims,
          send: (data) => socket.send(data),
          close: () => socket.close(4009, 'session resumed on a new connection'),
          log: req.log,
        },
        relayConfig,
      );

      void relay.start(resumeIntent ?? undefined).then((ok) => {
        if (!ok) {
          req.log.warn({ sub: claims.sub }, 'orchestrator session bootstrap failed');
          socket.close(4002, 'orchestrator unavailable');
          return;
        }
        if (socketClosed) {
          // The connection already dropped while start() was still in flight -- tear
          // down promptly rather than registering an entry for a dead socket (also
          // closes a pre-existing leak: previously nothing ever cleaned this up).
          relay.close();
          return;
        }
        if (relay.sessionId) relaySessionRegistry.register(relay.sessionId, relay);
      });

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // web-sdk prefixes every mic frame with the protocol's 1-byte AUDIO_INPUT_PCM16
          // type marker (encodeBinaryFrame) -- strip it before treating the rest as raw
          // PCM16, otherwise every buffered frame carries a spurious leading byte that
          // shifts 16-bit sample alignment for everything after it.
          const { type, payload } = decodeBinaryFrame(new Uint8Array(data));
          if (type === BinaryFrameType.AUDIO_INPUT_PCM16) {
            relay.handleAudioFrame(payload);
          } else {
            req.log.debug({ type }, 'ignoring unexpected binary frame type');
          }
        } else {
          relay.handleControlEvent(data.toString());
        }
      });

      socket.on('close', () => {
        socketClosed = true;
        const sessionId = relay.sessionId; // capture BEFORE close() nulls it internally
        relay.close();
        if (sessionId) relaySessionRegistry.unregister(sessionId, relay);
        req.log.info({ sub: claims.sub }, 'session closed');
      });
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
