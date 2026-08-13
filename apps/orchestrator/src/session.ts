import type { Redis } from 'ioredis';

export type TurnState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING';

export interface DialogueSession {
  sessionId: string;
  userId: string;
  role: 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';
  turnState: TurnState;
  slots: Record<string, unknown>;
  resumeToken: string;
  updatedAt: number;
}

const SESSION_TTL_SECONDS = 60 * 30; // 30 min idle timeout
const VITA_SESSION_PREFIX = 'vita:session:';
const LEGACY_SESSION_PREFIX = 'tera:session:';

/**
 * Redis-backed session store. In Phase 1 this points at a single Redis
 * instance; production should front it with Sentinel (or use a managed
 * Redis with HA) so an orchestrator pod restart doesn't drop every active
 * call — see docs/BUILD_GUIDE.md §5.5 and docs/ARCHITECTURE.md item 8.
 */
export class SessionStore {
  constructor(private redis: Redis) {}

  private keys(sessionId: string): string[] {
    return [`${VITA_SESSION_PREFIX}${sessionId}`, `${LEGACY_SESSION_PREFIX}${sessionId}`];
  }

  async create(session: Omit<DialogueSession, 'updatedAt'>): Promise<DialogueSession> {
    const full: DialogueSession = { ...session, updatedAt: Date.now() };
    await Promise.all(
      this.keys(session.sessionId).map((key) =>
        this.redis.set(key, JSON.stringify(full), 'EX', SESSION_TTL_SECONDS),
      ),
    );
    return full;
  }

  async get(sessionId: string): Promise<DialogueSession | null> {
    const [vitaRaw, legacyRaw] = await Promise.all(this.keys(sessionId).map((key) => this.redis.get(key)));
    const raw = vitaRaw ?? legacyRaw;
    return raw ? (JSON.parse(raw) as DialogueSession) : null;
  }

  /** Reattach after a client reconnect using the resume token, so a WiFi
   * blip doesn't force restarting the whole voice interaction. */
  async resume(sessionId: string, resumeToken: string): Promise<DialogueSession | null> {
    const session = await this.get(sessionId);
    if (!session || session.resumeToken !== resumeToken) return null;
    return session;
  }

  async update(sessionId: string, patch: Partial<DialogueSession>): Promise<DialogueSession | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await Promise.all(
      this.keys(sessionId).map((key) => this.redis.set(key, JSON.stringify(next), 'EX', SESSION_TTL_SECONDS)),
    );
    return next;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(...this.keys(sessionId));
  }
}
