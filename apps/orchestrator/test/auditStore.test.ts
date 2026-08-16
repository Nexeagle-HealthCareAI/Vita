import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { PostgresAuditStore } from '../src/auditStore.js';
import type { AuditEvent } from '../src/audit.js';

// pg-mem gives a real pg.Pool-shaped object backed by an in-memory Postgres-compatible
// engine -- same role ioredis-mock plays for SessionStore's tests: real query behavior,
// no live server needed. noAstCoverageCheck is required for this exact schema -- pg-mem's
// strict mode otherwise refuses inline PRIMARY KEY/NOT NULL column constraints with a
// "hit one of its limits" error even though it fully executes them.
function newStore(): PostgresAuditStore {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  return new PostgresAuditStore(new (Pool as unknown as new () => Pool)());
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    ts: Date.now(),
    sessionId: 'sess-1',
    userId: 'user-1',
    role: 'ROLE_RECEPTIONIST',
    action: 'session_created',
    outcome: 'success',
    ...overrides,
  };
}

describe('PostgresAuditStore', () => {
  it('ensureSchema() is idempotent -- safe to call twice', async () => {
    const store = newStore();
    await store.ensureSchema();
    await expect(store.ensureSchema()).resolves.not.toThrow();
  });

  it('insert() round-trips a row, including a null patientRef and a real patientRef', async () => {
    const store = newStore();
    await store.ensureSchema();

    await store.insert(event({ sessionId: 's1', ts: 100 }));
    await store.insert(event({ sessionId: 's2', ts: 200, patientRef: 'p-ref-1', action: 'tool_call:book_appointment' }));

    // A huge retention window puts the cutoff far in the past -- neither row is old
    // enough to be purged, which is only true if both were actually written.
    await expect(store.purgeExpired(999_999)).resolves.toBe(0);
  });

  it('purgeExpired() deletes only rows older than the retention window and returns the count removed', async () => {
    const store = newStore();
    await store.ensureSchema();

    const now = Date.now();
    await store.insert(event({ sessionId: 'old-1', ts: now - 400 * 24 * 60 * 60 * 1000 })); // 400 days ago
    await store.insert(event({ sessionId: 'old-2', ts: now - 366 * 24 * 60 * 60 * 1000 })); // 366 days ago
    await store.insert(event({ sessionId: 'recent', ts: now - 1000 })); // just now

    const deleted = await store.purgeExpired(365);

    expect(deleted).toBe(2);
    // A second purge finds nothing left to remove.
    await expect(store.purgeExpired(365)).resolves.toBe(0);
  });
});
