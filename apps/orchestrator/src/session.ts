import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ChatMessage } from './brain/types.js';
import { deriveKey, encrypt, decrypt } from './sessionCrypto.js';

export type TurnState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING';

export interface DialogueSession {
  sessionId: string;
  userId: string;
  /** UX-only bucket (system-prompt framing / Groq model selection, see pipeline.ts) --
   * derived server-side from `permissions` at session-creation time (see permissions.ts's
   * derivePersona). NEVER an authorization input -- see rbac.ts's Persona doc comment. Named
   * `persona`, not `role`, specifically so it doesn't invite being read as one again. */
  persona: 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';
  /** The calling staff member's REAL easyHMSAPI permission keys, resolved once at session-
   * creation time via GET user/permissions using their forwarded JWT (see permissions.ts) --
   * the actual authorization ground truth (see rbac.ts's TOOL_PERMISSIONS). Defaults to []
   * (deny-by-default) for a session with no hmsAccessToken or a failed resolve -- never
   * undefined. */
  permissions: string[];
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
   * are in use. Also the source `permissions` above is resolved from -- see permissions.ts. */
  hospitalId?: string;
  hmsAccessToken?: string;
  /** Monotonic generation, incremented on every successful resume (see
   * rotateResumeToken). Its job is to fence a SUPERSEDED connection's write: runTurn
   * snapshots history/slots and the caller writes the result back seconds later, so a
   * stale relay whose turn was already in flight when a resume landed would otherwise
   * clobber the new connection's completed turn (see update()'s expectedEpoch).
   *
   * Deliberately NOT resumeToken, even though that already rotates on resume: resumeToken
   * is a real credential (it's sent to the browser in SESSION_READY, and enables session
   * takeover), whereas an integer generation grants nothing and is safe to log freely --
   * which matters because the fence value has to ride the stream route's URL, and this
   * orchestrator runs Fastify({ logger: true }).
   *
   * Optional: sessions already in Redis when this field shipped read as undefined, which
   * every comparison below treats as 0. */
  epoch?: number;
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

  /** In-flight serialization chain per sessionId -- see withLock(). */
  private readonly chains = new Map<string, Promise<unknown>>();

  /**
   * Serializes get -> compare -> persist for one sessionId, so a stale in-flight turn
   * can't slip its write in between a live turn's own read and write (the read-modify-
   * write in update()/rotateResumeToken() is otherwise a lost-update vector regardless of
   * epochs). Deliberately wraps ONLY the ~2 Redis ops, never runTurn -- so the resume
   * route never head-of-line-blocks behind a 4-second turn.
   *
   * Same throw-safe promise-chain shape as apps/gateway/src/relay.ts's frameQueue rather
   * than a hand-rolled mutex: a rejected body can't wedge the chain, because the next
   * link attaches to the settled promise either way. The map entry is deleted once the
   * chain it owns settles, so this never grows unbounded.
   *
   * Correct because this orchestrator runs as a single container (docker-compose.prod.yml)
   * -- the same honesty as the gateway's RelaySessionRegistry. The epoch comparison below
   * is the part that stays correct if that ever changes.
   */
  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(sessionId) ?? Promise.resolve();
    // `.then(fn, fn)` so this link runs whether or not the prior one rejected -- a failed
    // write must never wedge every subsequent turn for that session.
    const run = prior.then(fn, fn);
    // A never-rejecting view of "this link finished", so the next link chains cleanly and
    // an unhandled rejection can't escape from the stored tail.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(sessionId, settled);
    void settled.then(() => {
      // Identity-checked delete -- only drop the entry if we're still the tail, since
      // something newer may have queued behind us. Same reasoning as the gateway's
      // RelaySessionRegistry.unregister().
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId);
    });
    return run;
  }

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
    try {
      const json = key ? decrypt(raw, key) : raw;
      return JSON.parse(json) as DialogueSession;
    } catch (err) {
      // A stored value that fails to decrypt/parse -- most commonly SESSION_ENCRYPTION_KEY
      // being rotated while this session was still live, see getEncryptionKey()'s doc
      // comment above -- previously threw straight out of get(). Every real caller awaits
      // this on a live turn's hot path (index.ts, streamSession.ts) with no surrounding
      // try/catch, so an unhandled rejection here would crash the whole orchestrator
      // process, not just this one session. Treat it the same as "session not found"
      // instead: every call site already handles that case safely, and it self-heals
      // within SESSION_TTL_SECONDS exactly as that doc comment already promises.
      console.error(JSON.stringify({ type: 'SESSION_DECODE_FAILED', sessionId, error: err instanceof Error ? err.message : String(err) }));
      return null;
    }
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
    return this.withLock(sessionId, async () => {
      const session = await this.get(sessionId);
      if (!session) return null;
      // Epoch bumped in the SAME persist() as the token rotation -- there is deliberately
      // no window where the token rotated but the fence didn't, which would let a
      // superseded connection keep writing.
      return this.persist({ ...session, resumeToken: randomUUID(), epoch: (session.epoch ?? 0) + 1 });
    });
  }

  /**
   * `expectedEpoch` omitted => unconditional write, byte-identical to this method's
   * behavior before the fence existed (every pre-existing caller and test relies on that).
   *
   * Supplied and mismatched => returns null and writes NOTHING: the session was resumed
   * on another connection while this caller's turn was running, so this write is a stale
   * snapshot that would clobber the newer connection's completed turn. Note the failure
   * is quiet by construction -- `update()` merges a patch, so fields absent from it
   * (resumeToken, epoch) survive a stale write and nothing downstream looks corrupted;
   * only history/slots/turnState silently regress. That's exactly why the caller must
   * check for null and surface it (see index.ts's SESSION_SUPERSEDED).
   */
  async update(
    sessionId: string,
    patch: Partial<DialogueSession>,
    opts?: { expectedEpoch?: number },
  ): Promise<DialogueSession | null> {
    return this.withLock(sessionId, async () => {
      const current = await this.get(sessionId);
      if (!current) return null;
      if (opts?.expectedEpoch !== undefined && (current.epoch ?? 0) !== opts.expectedEpoch) {
        console.warn(
          JSON.stringify({
            type: 'SESSION_WRITE_FENCED',
            sessionId,
            expectedEpoch: opts.expectedEpoch,
            actualEpoch: current.epoch ?? 0,
          }),
        );
        return null;
      }
      return this.persist({ ...current, ...patch });
    });
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(...this.keys(sessionId));
  }
}
