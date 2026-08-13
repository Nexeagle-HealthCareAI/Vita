import type { HmsClient } from '@vita/mcp-1hms';
import { assertToolPermission, type Role } from './rbac.js';
import type { GroqToolSchema } from './groq.js';

/**
 * JSON Schema equivalents of the Zod tool definitions in
 * packages/mcp-1hms/src/index.ts's buildMcpServer -- hand-written rather than generated
 * (zod-to-json-schema) since there are only 3 simple tools; keep these in sync manually
 * if the MCP tool shapes change. Reshaped to match easyHMSAPI's real public API: no
 * standalone patient-registration endpoint exists (book_appointment registers inline),
 * and there is no slot-reservation system (availability is shift windows, not slot IDs)
 * -- see hmsClient.ts's file header for the full explanation.
 */
export const GROQ_TOOL_SCHEMAS: GroqToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'find_doctors',
      description:
        'Find doctors by specialty/department, city, or name. Use this first to get a doctorId before checking availability or booking.',
      parameters: {
        type: 'object',
        properties: {
          specialtyCategory: { type: 'string', description: 'e.g. "Cardiology", "Gynaecology"' },
          city: { type: 'string' },
          search: { type: 'string', description: 'Free-text doctor name search' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_doctor_availability',
      description:
        'Check whether a specific doctor is working on a given date, and their shift timings. There is no discrete slot list -- a booking is a non-binding preferred time, confirmed by staff later.',
      parameters: {
        type: 'object',
        properties: {
          doctorId: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['doctorId', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Request an appointment for a patient with a specific doctor. Registers the patient as part of the same call -- there is no separate registration step. Non-binding: the hospital confirms the exact time later.',
      parameters: {
        type: 'object',
        properties: {
          doctorId: { type: 'string' },
          patientName: { type: 'string' },
          patientMobile: { type: 'string' },
          preferredDate: { type: 'string', description: 'YYYY-MM-DD' },
          preferredTime: { type: 'string', description: 'HH:MM, optional -- a preference, not a reservation' },
          reason: { type: 'string' },
        },
        required: ['doctorId', 'patientName', 'patientMobile', 'preferredDate'],
      },
    },
  },
];

export class UnknownToolError extends Error {
  constructor(tool: string) {
    super(`Unknown tool: ${tool}`);
    this.name = 'UnknownToolError';
  }
}

/**
 * Executes a tool in-process (see the plan's "in-process, not stdio MCP" decision) --
 * RBAC-checks first (assertToolPermission throws ForbiddenError, which the caller in
 * pipeline.ts catches and audits, same as the existing /session/:id/tool-call route
 * already does), then dispatches to the matching HmsClient method.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  role: Role,
  hms: HmsClient,
): Promise<unknown> {
  assertToolPermission(name, role);

  switch (name) {
    case 'find_doctors':
      return hms.findDoctors(args as { specialtyCategory?: string; city?: string; search?: string });
    case 'check_doctor_availability':
      return hms.checkDoctorAvailability(args as { doctorId: string; date: string });
    case 'book_appointment':
      return hms.bookAppointment(
        args as {
          doctorId: string;
          patientName: string;
          patientMobile: string;
          preferredDate: string;
          preferredTime?: string;
          reason?: string;
        },
      );
    default:
      throw new UnknownToolError(name);
  }
}
