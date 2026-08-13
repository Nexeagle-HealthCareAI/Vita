export type Role = 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';

/** Which role may invoke which MCP tool / data domain. Deny-by-default. */
const TOOL_PERMISSIONS: Record<string, Role[]> = {
  find_doctors: ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'],
  check_doctor_availability: ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'],
  book_appointment: ['ROLE_RECEPTIONIST'],
  read_patient_emr: ['ROLE_DOCTOR'],
  write_clinical_note: ['ROLE_DOCTOR'],
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
  const allowed = TOOL_PERMISSIONS[tool];
  if (!allowed || !allowed.includes(role)) {
    throw new ForbiddenError(tool, role);
  }
}
