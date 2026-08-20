/** UX-only bucketing -- selects system-prompt framing / Groq model (see pipeline.ts's
 * modelForRole/buildSystemPrompt). NEVER an authorization input -- see TOOL_PERMISSIONS
 * below for the real gate. Derived server-side from a session's real resolved permissions
 * (see permissions.ts's derivePersona), never trusted from a client-supplied value. */
export type Persona = 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';

interface ToolPermissionRule {
  /** OR semantics, matching easyHMSAPI's own [RequiresPermission(a, b)] convention --
   * holding ANY one listed key is enough. Empty = not additionally gated (still requires a
   * resolved session; permissions may legitimately be []). */
  anyOf: string[];
}

/** Which real easyHMSAPI permission key(s) a tool requires. Deny-by-default: an unlisted
 * tool name is never allowed (see isToolAllowed). Sourced from GET user/permissions (see
 * permissions.ts), the real easyHMSAPI authorization system -- NOT a hand-maintained shadow
 * copy of a role enum. */
const TOOL_PERMISSIONS: Record<string, ToolPermissionRule> = {
  find_doctors: { anyOf: [] },
  check_doctor_availability: { anyOf: [] },
  // hms.bookAppointment() calls POST /public/appointments, which is fully anonymous
  // server-side ([AllowAnonymous], no [RequiresPermission] -- see PublicController.cs).
  // Requiring appointment_scheduler/appointment_booking here is a VITA-IMPOSED policy
  // choice (only front-desk-capable sessions may trigger a voice booking), NOT a mirror of
  // a real backend gate -- do not "simplify" this to anyOf: [] just because no
  // RequiresPermission exists on the endpoint this tool actually calls.
  book_appointment: { anyOf: ['appointment_scheduler', 'appointment_booking'] },
  // Real gate: QueueController's [RequiresPermission("appointment_scheduler")] on
  // /queue/{doctorId}/mark-arrived, which hms.markAppointmentArrived() calls via staff auth.
  mark_appointment_arrived: { anyOf: ['appointment_scheduler'] },
  // Placeholders -- no tool schema/dispatch implemented yet. Real gate would be
  // DoctorDashboardController's [RequiresPermission("doc_board")].
  read_patient_emr: { anyOf: ['doc_board'] },
  write_clinical_note: { anyOf: ['doc_board'] },
  search_vita_faq: { anyOf: [] },
  search_hospital_reference: { anyOf: [] },
};

export class ForbiddenError extends Error {
  constructor(tool: string, permissions: string[]) {
    super(`permissions [${permissions.join(', ')}] do not permit calling ${tool}`);
    this.name = 'ForbiddenError';
  }
}

/**
 * permissions is expected to come from the session object, resolved once at session-
 * creation time from easyHMSAPI's real GET user/permissions endpoint (see permissions.ts
 * and apps/orchestrator/src/index.ts's POST /session route) -- never from a client-
 * controlled field on the request itself.
 */
export function assertToolPermission(tool: string, permissions: string[]): void {
  if (!isToolAllowed(tool, permissions)) {
    throw new ForbiddenError(tool, permissions);
  }
}

/** Non-throwing counterpart to assertToolPermission -- lets a caller FILTER (e.g.
 * tools.ts's toolSchemasForPermissions, pipeline.ts's buildSystemPrompt) rather than
 * reject. Same deny-by-default semantics: an unknown tool name is never allowed. */
export function isToolAllowed(tool: string, permissions: string[]): boolean {
  const rule = TOOL_PERMISSIONS[tool];
  if (!rule) return false;
  return rule.anyOf.length === 0 || rule.anyOf.some((key) => permissions.includes(key));
}

/** UX-only bucketing computed from a session's real resolved permissions -- see Persona's
 * doc comment above for the non-authorization invariant this must never violate. Only two
 * buckets exist because only two system-prompt/Groq-model variants exist today (see
 * pipeline.ts) -- not a stand-in for richer role modeling. */
export function derivePersona(permissions: string[]): Persona {
  return permissions.includes('doc_board') ? 'ROLE_DOCTOR' : 'ROLE_RECEPTIONIST';
}
