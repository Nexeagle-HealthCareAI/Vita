import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { BinaryFrameType, decodeBinaryFrame } from '@vita/protocol';
import { redeemTicket, verifyJwtAndIssueTicket } from './ticket.js';
import { AudioPreprocessClient } from './audioPreprocessClient.js';
import { OrchestratorClient } from './orchestratorClient.js';
import { ConnectionRelay, type RelayConfig } from './relay.js';

const JWT_SECRET = process.env.JWT_SIGNING_SECRET ?? 'change-me';
const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const TICKET_PROTOCOL_PREFIXES = ['vita-ticket.', 'tera-ticket.'] as const;

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

export function buildServer(deps?: { audioPreprocess?: AudioPreprocessClient; orchestrator?: OrchestratorClient }) {
  const audioPreprocess =
    deps?.audioPreprocess ?? new AudioPreprocessClient(process.env.AUDIO_PREPROCESS_URL ?? 'http://localhost:8090');
  const orchestrator =
    deps?.orchestrator ?? new OrchestratorClient(process.env.ORCHESTRATOR_INTERNAL_URL ?? 'http://localhost:8081');
  const relayConfig = relayConfigFromEnv();

  const app = Fastify({ logger: true });
  app.register(websocketPlugin);

  // Step 1: HTTPS ticket exchange. The long-lived JWT is verified here and
  // never leaves this request — the client gets back a short-lived,
  // single-use ticket to redeem on the WS upgrade.
  app.post('/session/ticket', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing bearer token' });
    }
    try {
      const ticket = verifyJwtAndIssueTicket(auth.slice('Bearer '.length), JWT_SECRET);
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

      const claims = ticket ? redeemTicket(ticket) : null;
      if (!claims) {
        socket.close(4001, 'invalid or expired ticket');
        return;
      }

      req.log.info({ sub: claims.sub, role: claims.role }, 'session established');

      // apps/gateway/src/relay.ts owns VAD-based utterance segmentation and the
      // LISTENING/PROCESSING/SPEAKING lifecycle for this connection; it calls out to
      // audio-preprocess (per frame) and the orchestrator (once per utterance) over
      // plain HTTP rather than a second WS -- see the relay plan for why.
      const relay = new ConnectionRelay(
        {
          audioPreprocess,
          orchestrator,
          claims,
          send: (data) => socket.send(data),
          log: req.log,
        },
        relayConfig,
      );

      void relay.start().then((ok) => {
        if (!ok) {
          req.log.warn({ sub: claims.sub }, 'orchestrator session bootstrap failed');
          socket.close(4002, 'orchestrator unavailable');
        }
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
        relay.close();
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
