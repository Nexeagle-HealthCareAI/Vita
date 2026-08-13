import type { HmsClient } from '@vita/mcp-1hms';
import { assertToolPermission, type Role } from './rbac.js';
import type { GroqToolSchema } from './groq.js';

/**
 * JSON Schema equivalents of the Zod tool definitions in
 * packages/mcp-1hms/src/index.ts's buildMcpServer -- hand-written rather than generated
 * (zod-to-json-schema) since there are only 3 simple tools; keep these in sync manually
 * if the MCP tool shapes change.
 */
export const GROQ_TOOL_SCHEMAS: GroqToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'register_patient',
      description: 'Register a new patient at the front desk',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          department: { type: 'string' },
          dob: { type: 'string', description: 'Date of birth, YYYY-MM-DD, optional' },
        },
        required: ['name', 'phone', 'department'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_slot_availability',
      description: 'Check available appointment slots for a department/doctor/date',
      parameters: {
        type: 'object',
        properties: {
          department: { type: 'string' },
          doctorId: { type: 'string', description: 'Optional -- narrows to one doctor' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['department', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Book a confirmed appointment slot for a patient',
      parameters: {
        type: 'object',
        properties: {
          patientId: { type: 'string' },
          doctorId: { type: 'string' },
          slotId: { type: 'string' },
        },
        required: ['patientId', 'doctorId', 'slotId'],
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
    case 'register_patient':
      return hms.registerPatient(args as { name: string; phone: string; department: string; dob?: string });
    case 'check_slot_availability':
      return hms.checkSlotAvailability(args as { department: string; doctorId?: string; date: string });
    case 'book_appointment':
      return hms.bookAppointment(args as { patientId: string; doctorId: string; slotId: string });
    default:
      throw new UnknownToolError(name);
  }
}
