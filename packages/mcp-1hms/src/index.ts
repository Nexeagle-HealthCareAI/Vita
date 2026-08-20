import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HmsClient } from './hmsClient.js';

// Re-exported so callers that want to invoke 1HMS in-process (the orchestrator's
// pipeline.ts, latency-sensitive on a live voice call) can import HmsClient directly
// instead of going through a spawned stdio MCP transport. buildMcpServer below still
// works unchanged as a real stdio MCP server for any other MCP client.
export { HmsClient } from './hmsClient.js';
export type {
  FindDoctorsInput,
  DoctorSummary,
  CheckDoctorAvailabilityInput,
  AvailabilityShift,
  BookAppointmentInput,
  HospitalRosterInput,
  RosterDoctor,
  MarkAppointmentArrivedInput,
  MarkAppointmentArrivedResult,
  StaffAuthContext,
} from './hmsClient.js';
// StaffAuthContext (see hmsClient.ts's file header) is NOT wired into buildMcpServer below:
// that stdio MCP surface has no RBAC/audit layer at all (its 3 existing tools all call the
// anonymous public/* surface unconditionally), so a staff-privileged mutating action stays
// reachable ONLY through the orchestrator's own RBAC+audit-gated executeTool dispatch
// (apps/orchestrator/src/tools.ts), never through this generic path.

const hms = new HmsClient(
  process.env.HMS_API_BASE_URL ?? 'http://localhost:5000',
  process.env.HMS_API_KEY ?? '',
);

export function buildMcpServer(client: HmsClient = hms): McpServer {
  const server = new McpServer({ name: 'vita-1hms', version: '0.2.0' });

  // No standalone patient-registration endpoint exists on 1HMS's public API -- a
  // booking creates/matches the patient inline (see book_appointment below). This tool
  // exists to resolve "which doctor" from a department/specialty name first, since
  // check_doctor_availability and book_appointment both require a specific doctorId
  // and 1HMS has no department-wide slot search.
  server.tool(
    'find_doctors',
    'Find doctors by specialty/department, city, or name -- use this first to get a doctorId before checking availability or booking',
    {
      specialtyCategory: z.string().optional().describe('e.g. "Cardiology", "Gynaecology"'),
      city: z.string().optional(),
      search: z.string().optional().describe('Free-text doctor name search'),
    },
    async (input) => {
      const result = await client.findDoctors(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'check_doctor_availability',
    "Check whether a specific doctor is working on a given date, and their shift timings. There is no discrete slot list -- a booking is a non-binding preferred time, confirmed by staff later.",
    {
      doctorId: z.string(),
      date: z.string().describe('YYYY-MM-DD'),
    },
    async (input) => {
      const result = await client.checkDoctorAvailability(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'book_appointment',
    'Request an appointment for a patient with a specific doctor. Registers the patient as part of the same call -- there is no separate registration step. Non-binding: the hospital confirms the exact time later.',
    {
      doctorId: z.string(),
      patientName: z.string(),
      patientMobile: z.string(),
      preferredDate: z.string().describe('YYYY-MM-DD'),
      preferredTime: z.string().optional().describe('HH:MM, optional -- a preference, not a reservation'),
      reason: z.string().optional(),
    },
    async (input) => {
      const result = await client.bookAppointment(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

if (process.env.NODE_ENV !== 'test') {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
