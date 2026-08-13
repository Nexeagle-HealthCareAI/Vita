import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { redeemTicket, verifyJwtAndIssueTicket } from './ticket.js';

const JWT_SECRET = process.env.JWT_SIGNING_SECRET ?? 'change-me';
const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const TICKET_PROTOCOL_PREFIXES = ['vita-ticket.', 'tera-ticket.'] as const;

export function extractTicketProtocol(protocols: string[]): string | undefined {
  const ticketProtocol = protocols.find((protocol) =>
    TICKET_PROTOCOL_PREFIXES.some((prefix) => protocol.startsWith(prefix)),
  );
  if (!ticketProtocol) return undefined;

  const prefix = TICKET_PROTOCOL_PREFIXES.find((candidate) => ticketProtocol.startsWith(candidate));
  return prefix ? ticketProtocol.slice(prefix.length) : undefined;
}

export function buildServer() {
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

      // TODO(orchestrator relay): open an internal WS/gRPC stream to
      // ORCHESTRATOR_INTERNAL_URL, tag it with claims.sub/claims.role, and
      // pipe binary frames + control JSON both ways. Stubbed here so the
      // gateway is independently testable; see docs/BUILD_GUIDE.md §5.4.
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // relay raw PCM16 frame to orchestrator (not yet wired in this stub)
          req.log.debug({ bytes: data.byteLength }, 'audio frame received');
        } else {
          req.log.debug({ msg: data.toString() }, 'control event received');
        }
      });

      socket.on('close', () => {
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
