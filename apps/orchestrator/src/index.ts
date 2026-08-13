import Fastify from 'fastify';
import { Redis as IORedis, type Redis } from 'ioredis';
import { SessionStore } from './session.js';
import { assertToolPermission, ForbiddenError, type Role } from './rbac.js';
import { recordAuditEvent } from './audit.js';

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function buildServer(redisClient?: Redis) {
  const redis = redisClient ?? new IORedis(REDIS_URL);
  const sessions = new SessionStore(redis);
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Internal endpoint the gateway relays to once a ticket is redeemed.
  // Real audio/LLM/TTS orchestration wires in here — see
  // docs/BUILD_GUIDE.md §5 through §7 for the STT -> LLM -> MCP/RAG -> TTS
  // pipeline this stub is the entry point for.
  app.post('/session', async (req, reply) => {
    const body = req.body as { sessionId: string; userId: string; role: Role };
    const session = await sessions.create({
      sessionId: body.sessionId,
      userId: body.userId,
      role: body.role,
      turnState: 'IDLE',
      slots: {},
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
    // TODO: dispatch to packages/mcp-1hms or packages/rag depending on `tool`.
    return reply.send({ status: 'accepted', tool });
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
