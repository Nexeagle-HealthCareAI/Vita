import { Pool } from 'pg';
import { PostgresAuditStore } from './auditStore.js';

export interface AuditEvent {
  ts: number;
  sessionId: string;
  userId: string;
  role: string;
  action: string; // e.g. "tool_call:register_patient", "rag_query", "form_autofill_push"
  patientRef?: string; // opaque reference, never raw PHI in the log line itself
  outcome: 'success' | 'error' | 'denied';
}

// Lazily constructed from DATABASE_URL -- unset in every test/CI environment today, so
// recordAuditEvent() there stays the pure stdout stub it's always been; no existing test
// (or the ~14 call sites across index.ts/pipeline.ts/streamSession.ts) needs to change.
// Overridable via _setAuditStoreForTests() for tests that DO want to exercise the
// Postgres path (see auditStore.test.ts / audit.test.ts), same seam-naming precedent as
// ticket.ts's _clearTicketsForTests().
let store: PostgresAuditStore | null = null;

function getStore(): PostgresAuditStore | null {
  if (store) return store;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  store = new PostgresAuditStore(new Pool({ connectionString: url }));
  return store;
}

/**
 * DPDPA-alignment: every access to or action on patient data gets a durable, queryable
 * record of who/when/what. Always logs to stdout (cheap, still useful for live tailing);
 * additionally fire-and-forget writes to Postgres when DATABASE_URL is configured (see
 * auditStore.ts) -- a DB hiccup must never fail the live route that triggered this call
 * (a booking, a turn, a session resume, etc.), so failures are logged, not thrown.
 * Retention (default 1 year, AUDIT_RETENTION_DAYS) is enforced by initAuditStore()'s
 * periodic purge, not here. See docs/ARCHITECTURE.md §2 item 9 and docs/BUILD_GUIDE.md §6.
 */
export function recordAuditEvent(event: AuditEvent): void {
  console.log(JSON.stringify({ type: 'AUDIT', ...event }));
  const s = getStore();
  if (!s) return;
  void s.insert(event).catch((err) => {
    console.error(JSON.stringify({ type: 'AUDIT_WRITE_FAILED', error: err instanceof Error ? err.message : String(err) }));
  });
}

/** Called once at real process startup (see index.ts's `NODE_ENV !== 'test'` guard) --
 * never from buildServer() itself, so no test transitively triggers a real DB connection.
 * A no-op when DATABASE_URL isn't set. */
export async function initAuditStore(): Promise<void> {
  const s = getStore();
  if (!s) return;
  await s.ensureSchema();
  const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
  const purge = () =>
    void s.purgeExpired(retentionDays).catch((err) => {
      console.error(JSON.stringify({ type: 'AUDIT_PURGE_FAILED', error: err instanceof Error ? err.message : String(err) }));
    });
  purge();
  setInterval(purge, 24 * 60 * 60 * 1000).unref();
}

export function _setAuditStoreForTests(override: PostgresAuditStore | null): void {
  store = override;
}
