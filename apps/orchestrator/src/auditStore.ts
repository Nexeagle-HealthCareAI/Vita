import type { Pool } from 'pg';
import type { AuditEvent } from './audit.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Durable, queryable backing store for the audit trail (docs/BUILD_GUIDE.md §6) --
 * `ts` stays the same epoch-ms number already on AuditEvent, no conversion, and is
 * indexed since it's what both range queries and purgeExpired()'s retention cutoff
 * filter on.
 */
export class PostgresAuditStore {
  constructor(private pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGSERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        patient_ref TEXT,
        outcome TEXT NOT NULL
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS audit_events_ts_idx ON audit_events (ts)`);
  }

  async insert(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (ts, session_id, user_id, role, action, patient_ref, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.ts, event.sessionId, event.userId, event.role, event.action, event.patientRef ?? null, event.outcome],
    );
  }

  /** Deletes rows older than retentionDays, returning the number of rows removed. */
  async purgeExpired(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * MS_PER_DAY;
    const result = await this.pool.query('DELETE FROM audit_events WHERE ts < $1', [cutoff]);
    return result.rowCount ?? 0;
  }
}
