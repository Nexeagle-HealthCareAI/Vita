import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ChatMessage } from './brain/types.js';
import { deriveKey, encrypt, decrypt } from './sessionCrypto.js';

export type TurnState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING';

export interface DialogueSession {
  sessionId: string;
  userId: string;
  role: 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';
  turnState: TurnState;
  slots: Record<string, unknown>;
  /** Conversation history sent to Groq on every turn -- without this the LLM has no
   * memory of anything said earlier in the call. Grows per session; Phase 1 has no
   * trimming/summarization, see docs/BUILD_GUIDE.md if this becomes a token-budget issue. */
  history: ChatMessage[];
  resumeToken: string;
  /** Forwarded from the calling staff member's own easyHMSWeb session at ticket-mint time
   * (see apps/gateway/src/ticket.ts's SessionClaims) -- Vita never mints or holds a
   * credential of its own. Both optional: an older/malformed ticket, or a non-staff
   * session, simply has no staff-auth tools available (see tools.ts's
   * StaffAuthUnavailableError), not a hard failure. hmsAccessToken is a real, live bearer
   * credential -- see .env.example's SESSION_ENCRYPTION_KEY comment, since this field is
   * exactly why that key should be treated as effectively mandatory once staff-auth tools
   * are in use. */
  hospitalId?: string;
  hmsAccessToken?: string;
  updatedAt: number;
}

const SESSION_TTL_SECONDS = 60 * 30; // 30 min idle timeout
const VITA_SESSION_PREFIX = 'vita:session:';
const LEGACY_SESSION_PREFIX = 'tera:session:';

/** Read fresh on every call (not cached) -- cheap (a hash/buffer conversion, not a
 * connection), and lets tests toggle SESSION_ENCRYPTION_KEY per-case without stale state.
 * Unset -> null -> persist()/get() store/read plain JSON, exactly today's behavior
 * (docs/BUILD_GUIDE.md §6). Whether a key is configured *right now* is what decides how a
 * value is read -- there's no auto-detection of "is this value encrypted," so flipping the
 * env var mid-flight makes any session from the old mode unreadable until it expires. That
 * self-heals within SESSION_TTL_SECONDS (30 min), so no migration logic is needed here. */
function getEncryptionKey(): Buffer | null {
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  return raw ? deriveKey(raw) : null;
}

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

  /** Shared dual-key (vita: + legacy tera:) SET...EX write used by create/update/resume/
   * rotateResumeToken, so the "refresh TTL on every successful touch" invariant can't
   * drift between them again -- this is exactly the invariant resume() used to violate
   * (see its own doc comment below). */
  private async persist(session: Omit<DialogueSession, 'updatedAt'>): Promise<DialogueSession> {
    const full: DialogueSession = { ...session, updatedAt: Date.now() };
    const key = getEncryptionKey();
    const json = JSON.stringify(full);
    const payload = key ? encrypt(json, key) : json;
    await Promise.all(this.keys(full.sessionId).map((k) => this.redis.set(k, payload, 'EX', SESSION_TTL_SECONDS)));
    return full;
  }

  async create(session: Omit<DialogueSession, 'updatedAt'>): Promise<DialogueSession> {
    return this.persist(session);
  }

  async get(sessionId: string): Promise<DialogueSession | null> {
    const [vitaRaw, legacyRaw] = await Promise.all(this.keys(sessionId).map((key) => this.redis.get(key)));
    const raw = vitaRaw ?? legacyRaw;
    if (!raw) return null;
    const key = getEncryptionKey();
    const json = key ? decrypt(raw, key) : raw;
    return JSON.parse(json) as DialogueSession;
  }

  /** Reattach after a client reconnect using the resume token, so a WiFi blip doesn't
   * force restarting the whole voice interaction. Refreshes the TTL on success via
   * persist() -- previously this returned the session as-is without ever re-writing it,
   * so a "successfully resumed" session kept counting down toward its ORIGINAL expiry.
   * Deliberately does NOT rotate the token or check userId -- both are the caller's
   * (route's) job, not the store's, see rotateResumeToken(). */
  async resume(sessionId: string, resumeToken: string): Promise<DialogueSession | null> {
    const session = await this.get(sessionId);
    if (!session || session.resumeToken !== resumeToken) return null;
    return this.persist(session);
  }

  /** Mints and persists a new resumeToken for an already-authorized session (refreshing
   * TTL in the same write). Deliberately separate from resume() -- call this only AFTER
   * the caller has independently verified the requester is actually allowed to resume
   * this session (e.g. a userId cross-check). If resume() rotated the token itself, a
   * request carrying a leaked-but-real token alongside a wrong/spoofed userId would still
   * silently invalidate the legitimate owner's token before that check ever ran.
   * Single-use-per-resume: closes the replay window on a captured sessionId+token pair,
   * mirroring ticket.ts's single-use ticket. */
  async rotateResumeToken(sessionId: string): Promise<DialogueSession | null> {
    const session = await this.get(sessionId);
    if (!session) return null;
    return this.persist({ ...session, resumeToken: randomUUID() });
  }

  async update(sessionId: string, patch: Partial<DialogueSession>): Promise<DialogueSession | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    return this.persist({ ...current, ...patch });
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(...this.keys(sessionId));
  }
}
