import type { HmsClient } from '@vita/mcp-1hms';
import type { HybridRetriever } from '@vita/rag';
import { FAQ_DOCS } from '@vita/rag';
import { assertToolPermission, type Role } from './rbac.js';
import type { ToolSchema } from './brain/types.js';

/**
 * JSON Schema equivalents of the Zod tool definitions in
 * packages/mcp-1hms/src/index.ts's buildMcpServer -- hand-written rather than generated
 * (zod-to-json-schema) since there are only 3 simple tools; keep these in sync manually
 * if the MCP tool shapes change. Reshaped to match easyHMSAPI's real public API: no
 * standalone patient-registration endpoint exists (book_appointment registers inline),
 * and there is no slot-reservation system (availability is shift windows, not slot IDs)
 * -- see hmsClient.ts's file header for the full explanation.
 */
export const TOOL_SCHEMAS: ToolSchema[] = [
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
  {
    type: 'function',
    function: {
      name: 'search_vita_faq',
      description:
        'Answer generic questions about Vita itself -- what it is, what it can do, where it runs, who built it, what languages it understands, whether bookings are final, etc. Not for patient, doctor, or appointment data -- use the other tools for those.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The question being asked, in plain language' },
        },
        required: ['query'],
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
 *
 * `retriever` is optional (unlike `hms`) so every existing caller/test keeps compiling
 * unchanged -- mirrors GroqBrainProvider's optional `apiUrl` param elsewhere in this codebase.
 * If search_vita_faq is requested with no retriever supplied, that's the same drift-guard
 * UnknownToolError the switch already throws for RBAC-allowed-but-unimplemented tools
 * (e.g. read_patient_emr).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  role: Role,
  hms: HmsClient,
  retriever?: HybridRetriever,
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
    case 'search_vita_faq': {
      if (!retriever) throw new UnknownToolError(name);
      const { query } = args as { query: string };
      const hits = await retriever.search(query, 3);
      // Return clean {question, answer} pairs, not HybridSearchResult's raw indexed blob --
      // keeps HybridRetriever a generic, FAQ-agnostic primitive; shaping what the LLM sees
      // is this layer's job, same separation already used for the HmsClient tools above.
      return hits
        .map((hit) => FAQ_DOCS.find((doc) => doc.id === hit.id))
        .filter((doc): doc is (typeof FAQ_DOCS)[number] => doc !== undefined)
        .map((doc) => ({ question: doc.question, answer: doc.answer }));
    }
    default:
      throw new UnknownToolError(name);
  }
}
