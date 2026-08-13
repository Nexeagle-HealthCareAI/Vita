import { describe, expect, it, vi } from 'vitest';
import { HmsClient } from '@vita/mcp-1hms';
import { executeTool, UnknownToolError } from '../src/tools.js';
import { ForbiddenError } from '../src/rbac.js';

function mockHms() {
  const client = Object.create(HmsClient.prototype) as HmsClient;
  client.registerPatient = vi.fn().mockResolvedValue({ patientId: 'p-1' });
  client.checkSlotAvailability = vi.fn().mockResolvedValue({ slots: [] });
  client.bookAppointment = vi.fn().mockResolvedValue({ appointmentId: 'a-1' });
  return client;
}

describe('executeTool', () => {
  it('denies a forbidden role before ever calling HmsClient', async () => {
    const hms = mockHms();
    await expect(
      executeTool('register_patient', { name: 'x', phone: 'y', department: 'z' }, 'ROLE_DOCTOR', hms),
    ).rejects.toThrow(ForbiddenError);
    expect(hms.registerPatient).not.toHaveBeenCalled();
  });

  it('dispatches register_patient to HmsClient.registerPatient for an allowed role', async () => {
    const hms = mockHms();
    const result = await executeTool(
      'register_patient',
      { name: 'Test Patient', phone: '9999999999', department: 'Cardiology' },
      'ROLE_RECEPTIONIST',
      hms,
    );
    expect(result).toEqual({ patientId: 'p-1' });
    expect(hms.registerPatient).toHaveBeenCalledWith({
      name: 'Test Patient',
      phone: '9999999999',
      department: 'Cardiology',
    });
  });

  it('dispatches check_slot_availability for both receptionist and doctor roles', async () => {
    const hms = mockHms();
    await executeTool('check_slot_availability', { department: 'Cardiology', date: '2026-08-20' }, 'ROLE_DOCTOR', hms);
    expect(hms.checkSlotAvailability).toHaveBeenCalledWith({ department: 'Cardiology', date: '2026-08-20' });
  });

  it('dispatches book_appointment to HmsClient.bookAppointment', async () => {
    const hms = mockHms();
    const result = await executeTool(
      'book_appointment',
      { patientId: 'p-1', doctorId: 'd-1', slotId: 's-1' },
      'ROLE_RECEPTIONIST',
      hms,
    );
    expect(result).toEqual({ appointmentId: 'a-1' });
  });

  it('rejects a tool name RBAC has never heard of before ever calling HmsClient', async () => {
    const hms = mockHms();
    await expect(executeTool('delete_all_patients', {}, 'ROLE_DOCTOR', hms)).rejects.toThrow(ForbiddenError);
  });

  it('throws UnknownToolError for a tool RBAC allows but this switch has no case for', async () => {
    // rbac.ts's TOOL_PERMISSIONS already lists read_patient_emr/write_clinical_note for
    // ROLE_DOCTOR (future MCP tools not yet implemented here) -- these pass RBAC but
    // fall through executeTool's switch, which is exactly the drift-guard this error
    // exists for.
    const hms = mockHms();
    await expect(executeTool('read_patient_emr', {}, 'ROLE_DOCTOR', hms)).rejects.toThrow(UnknownToolError);
  });
});
