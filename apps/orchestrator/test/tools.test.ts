import { describe, expect, it, vi } from 'vitest';
import { HmsClient } from '@vita/mcp-1hms';
import { executeTool, UnknownToolError } from '../src/tools.js';
import { ForbiddenError } from '../src/rbac.js';

function mockHms() {
  const client = Object.create(HmsClient.prototype) as HmsClient;
  client.findDoctors = vi.fn().mockResolvedValue({ doctors: [{ doctorId: 'd-1', fullName: 'Dr. Test' }], totalCount: 1 });
  client.checkDoctorAvailability = vi.fn().mockResolvedValue({ isAvailable: true, reason: null, shifts: [] });
  client.bookAppointment = vi.fn().mockResolvedValue({ success: true, message: null, appointmentId: 'a-1', patientId: 'p-1', isReminderSent: true });
  return client;
}

describe('executeTool', () => {
  it('denies a forbidden role before ever calling HmsClient', async () => {
    const hms = mockHms();
    await expect(
      executeTool(
        'book_appointment',
        { doctorId: 'd-1', patientName: 'x', patientMobile: 'y', preferredDate: '2026-08-20' },
        'ROLE_DOCTOR',
        hms,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(hms.bookAppointment).not.toHaveBeenCalled();
  });

  it('dispatches find_doctors to HmsClient.findDoctors for both allowed roles', async () => {
    const hms = mockHms();
    const result = await executeTool('find_doctors', { specialtyCategory: 'Cardiology' }, 'ROLE_RECEPTIONIST', hms);
    expect(result).toEqual({ doctors: [{ doctorId: 'd-1', fullName: 'Dr. Test' }], totalCount: 1 });
    expect(hms.findDoctors).toHaveBeenCalledWith({ specialtyCategory: 'Cardiology' });

    const hms2 = mockHms();
    await executeTool('find_doctors', {}, 'ROLE_DOCTOR', hms2);
    expect(hms2.findDoctors).toHaveBeenCalled();
  });

  it('dispatches check_doctor_availability for both receptionist and doctor roles', async () => {
    const hms = mockHms();
    await executeTool('check_doctor_availability', { doctorId: 'd-1', date: '2026-08-20' }, 'ROLE_DOCTOR', hms);
    expect(hms.checkDoctorAvailability).toHaveBeenCalledWith({ doctorId: 'd-1', date: '2026-08-20' });
  });

  it('dispatches book_appointment to HmsClient.bookAppointment (receptionist-only)', async () => {
    const hms = mockHms();
    const input = { doctorId: 'd-1', patientName: 'Test Patient', patientMobile: '9999999999', preferredDate: '2026-08-20' };
    const result = await executeTool('book_appointment', input, 'ROLE_RECEPTIONIST', hms);
    expect(result).toEqual({ success: true, message: null, appointmentId: 'a-1', patientId: 'p-1', isReminderSent: true });
    expect(hms.bookAppointment).toHaveBeenCalledWith(input);
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
