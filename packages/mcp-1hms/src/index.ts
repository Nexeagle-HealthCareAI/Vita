import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HmsClient } from './hmsClient.js';

const hms = new HmsClient(
  process.env.HMS_API_BASE_URL ?? 'http://localhost:5000',
  process.env.HMS_API_KEY ?? '',
);

export function buildMcpServer(client: HmsClient = hms): McpServer {
  const server = new McpServer({ name: 'tera-1hms', version: '0.1.0' });

  server.tool(
    'register_patient',
    'Register a new patient at the front desk',
    {
      name: z.string(),
      phone: z.string(),
      department: z.string(),
      dob: z.string().optional(),
    },
    async (input) => {
      const result = await client.registerPatient(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'check_slot_availability',
    'Check available appointment slots for a department/doctor/date',
    {
      department: z.string(),
      doctorId: z.string().optional(),
      date: z.string(),
    },
    async (input) => {
      const result = await client.checkSlotAvailability(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'book_appointment',
    'Book a confirmed appointment slot for a patient',
    {
      patientId: z.string(),
      doctorId: z.string(),
      slotId: z.string(),
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
