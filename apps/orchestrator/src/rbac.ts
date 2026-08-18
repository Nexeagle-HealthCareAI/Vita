export type Role = 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';

/** Which role may invoke which MCP tool / data domain. Deny-by-default. */
const TOOL_PERMISSIONS: Record<string, Role[]> = {
  find_doctors: ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'],
  check_doctor_availability: ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'],
  book_appointment: ['ROLE_RECEPTIONIST'],
  read_patient_emr: ['ROLE_DOCTOR'],
  write_clinical_note: ['ROLE_DOCTOR'],
  search_vita_faq: ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'],
  search_hospital_reference: ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'],
};

export class ForbiddenError extends Error {
  constructor(tool: string, role: Role) {
    super(`role ${role} is not permitted to call ${tool}`);
    this.name = 'ForbiddenError';
  }
}

/**
 * Role is expected to come from the session object populated at ticket
 * redemption time (see apps/gateway/src/ticket.ts) — i.e. from the verified
 * JWT, never from a client-controlled field on the request itself.
 */
export function assertToolPermission(tool: string, role: Role): void {
  if (!isToolAllowed(tool, role)) {
    throw new ForbiddenError(tool, role);
  }
}

/** Non-throwing counterpart to assertToolPermission -- lets a caller FILTER (e.g.
 * tools.ts's toolSchemasForRole, pipeline.ts's buildSystemPrompt) rather than reject.
 * Same deny-by-default semantics: an unknown tool name is never allowed. */
export function isToolAllowed(tool: string, role: Role): boolean {
  const allowed = TOOL_PERMISSIONS[tool];
  return !!allowed && allowed.includes(role);
}
