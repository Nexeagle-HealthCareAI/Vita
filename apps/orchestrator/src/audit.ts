export interface AuditEvent {
  ts: number;
  sessionId: string;
  userId: string;
  role: string;
  action: string; // e.g. "tool_call:register_patient", "rag_query", "form_autofill_push"
  patientRef?: string; // opaque reference, never raw PHI in the log line itself
  outcome: 'success' | 'error' | 'denied';
}

/**
 * DPDPA-alignment starting point: every access to or action on patient data
 * gets a durable, queryable record of who/when/what. Phase 1 stub logs to
 * stdout (picked up by the container log driver); before go-live this must
 * write to an append-only store (dedicated Postgres table or log service)
 * with a defined retention period — see docs/ARCHITECTURE.md §2 item 9 and
 * docs/BUILD_GUIDE.md §9 (compliance checklist).
 */
export function recordAuditEvent(event: AuditEvent): void {
  console.log(JSON.stringify({ type: 'AUDIT', ...event }));
}
