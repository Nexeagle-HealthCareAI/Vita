import { describe, expect, it, vi } from 'vitest';
import { HmsClient, type StaffAuthContext } from '@vita/mcp-1hms';
import { FAQ_DOCS, HOSPITAL_REFERENCE_DOCS } from '@vita/rag';
import { executeTool, toolSchemasForPermissions, UnknownToolError, StaffAuthUnavailableError } from '../src/tools.js';
import { ForbiddenError } from '../src/rbac.js';
import { mockRetriever } from './helpers.js';

const STAFF_AUTH: StaffAuthContext = { hospitalId: 'h-1', accessToken: 'real-staff-jwt' };
const RECEPTIONIST_PERMISSIONS = ['appointment_scheduler'];
const DOCTOR_PERMISSIONS = ['doc_board'];

function mockHms() {
  const client = Object.create(HmsClient.prototype) as HmsClient;
  client.findDoctors = vi.fn().mockResolvedValue({ doctors: [{ doctorId: 'd-1', fullName: 'Dr. Test' }], totalCount: 1 });
  client.checkDoctorAvailability = vi.fn().mockResolvedValue({ isAvailable: true, reason: null, shifts: [] });
  client.bookAppointment = vi.fn().mockResolvedValue({ success: true, message: null, appointmentId: 'a-1', patientId: 'p-1', isReminderSent: true });
  client.markAppointmentArrived = vi.fn().mockResolvedValue({ success: true, message: null, tokenNo: 5, status: 'READY' });
  return client;
}

describe('toolSchemasForPermissions (upfront RBAC -- what gets offered to the model)', () => {
  it('excludes book_appointment and mark_appointment_arrived for a doctor-shaped permission set but includes everything else', () => {
    const names = toolSchemasForPermissions(DOCTOR_PERMISSIONS).map((s) => s.function.name);
    expect(names).not.toContain('book_appointment');
    expect(names).not.toContain('mark_appointment_arrived');
    expect(names).toEqual(
      expect.arrayContaining(['find_doctors', 'check_doctor_availability', 'search_vita_faq', 'search_hospital_reference']),
    );
  });

  it('includes every tool, including book_appointment and mark_appointment_arrived, for a receptionist-shaped permission set', () => {
    const names = toolSchemasForPermissions(RECEPTIONIST_PERMISSIONS).map((s) => s.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'find_doctors',
        'check_doctor_availability',
        'book_appointment',
        'mark_appointment_arrived',
        'search_vita_faq',
        'search_hospital_reference',
      ]),
    );
  });

  it('OR semantics: appointment_booking alone also unlocks book_appointment in the offered tool list', () => {
    const names = toolSchemasForPermissions(['appointment_booking']).map((s) => s.function.name);
    expect(names).toContain('book_appointment');
  });
});

describe('executeTool', () => {
  it('denies a permission set that lacks the required key before ever calling HmsClient', async () => {
    const hms = mockHms();
    await expect(
      executeTool(
        'book_appointment',
        { doctorId: 'd-1', patientName: 'x', patientMobile: 'y', preferredDate: '2026-08-20' },
        DOCTOR_PERMISSIONS,
        hms,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(hms.bookAppointment).not.toHaveBeenCalled();
  });

  it('dispatches find_doctors to HmsClient.findDoctors regardless of permissions (anyOf: [])', async () => {
    const hms = mockHms();
    const result = await executeTool('find_doctors', { specialtyCategory: 'Cardiology' }, RECEPTIONIST_PERMISSIONS, hms);
    expect(result).toEqual({ doctors: [{ doctorId: 'd-1', fullName: 'Dr. Test' }], totalCount: 1 });
    expect(hms.findDoctors).toHaveBeenCalledWith({ specialtyCategory: 'Cardiology' });

    const hms2 = mockHms();
    await executeTool('find_doctors', {}, DOCTOR_PERMISSIONS, hms2);
    expect(hms2.findDoctors).toHaveBeenCalled();
  });

  it('dispatches check_doctor_availability regardless of permissions', async () => {
    const hms = mockHms();
    await executeTool('check_doctor_availability', { doctorId: 'd-1', preferredDate: '2026-08-20' }, DOCTOR_PERMISSIONS, hms);
    expect(hms.checkDoctorAvailability).toHaveBeenCalledWith({ doctorId: 'd-1', date: '2026-08-20' });
  });

  it('dispatches book_appointment to HmsClient.bookAppointment for a session holding appointment_scheduler', async () => {
    const hms = mockHms();
    const input = { doctorId: 'd-1', patientName: 'Test Patient', patientMobile: '9999999999', preferredDate: '2026-08-20' };
    const result = await executeTool('book_appointment', input, RECEPTIONIST_PERMISSIONS, hms);
    expect(result).toEqual({ success: true, message: null, appointmentId: 'a-1', patientId: 'p-1', isReminderSent: true });
    expect(hms.bookAppointment).toHaveBeenCalledWith(input);
  });

  it('dispatches mark_appointment_arrived to HmsClient.markAppointmentArrived with the session-derived staffAuthContext', async () => {
    const hms = mockHms();
    const input = { appointmentId: 'a-1', doctorId: 'd-1' };
    const result = await executeTool('mark_appointment_arrived', input, RECEPTIONIST_PERMISSIONS, hms, undefined, undefined, STAFF_AUTH);
    expect(result).toEqual({ success: true, message: null, tokenNo: 5, status: 'READY' });
    expect(hms.markAppointmentArrived).toHaveBeenCalledWith(input, STAFF_AUTH);
  });

  it('denies a doctor-shaped session calling mark_appointment_arrived before ever calling HmsClient', async () => {
    const hms = mockHms();
    await expect(
      executeTool('mark_appointment_arrived', { appointmentId: 'a-1', doctorId: 'd-1' }, DOCTOR_PERMISSIONS, hms, undefined, undefined, STAFF_AUTH),
    ).rejects.toThrow(ForbiddenError);
    expect(hms.markAppointmentArrived).not.toHaveBeenCalled();
  });

  it('throws StaffAuthUnavailableError for mark_appointment_arrived when the session has no forwarded staff credential', async () => {
    const hms = mockHms();
    await expect(
      executeTool('mark_appointment_arrived', { appointmentId: 'a-1', doctorId: 'd-1' }, RECEPTIONIST_PERMISSIONS, hms),
    ).rejects.toThrow(StaffAuthUnavailableError);
    expect(hms.markAppointmentArrived).not.toHaveBeenCalled();
  });

  it('rejects a tool name RBAC has never heard of before ever calling HmsClient', async () => {
    const hms = mockHms();
    await expect(executeTool('delete_all_patients', {}, DOCTOR_PERMISSIONS, hms)).rejects.toThrow(ForbiddenError);
  });

  it('throws UnknownToolError for a tool RBAC allows but this switch has no case for', async () => {
    // rbac.ts's TOOL_PERMISSIONS already lists read_patient_emr/write_clinical_note as
    // requiring doc_board (future MCP tools not yet implemented here) -- these pass RBAC
    // but fall through executeTool's switch, which is exactly the drift-guard this error
    // exists for.
    const hms = mockHms();
    await expect(executeTool('read_patient_emr', {}, DOCTOR_PERMISSIONS, hms)).rejects.toThrow(UnknownToolError);
  });

  it('dispatches search_vita_faq to the retriever and maps hits back to {question, answer} pairs', async () => {
    const hms = mockHms();
    const doc = FAQ_DOCS[0]!;
    const faqRetriever = mockRetriever([{ id: doc.id, text: 'irrelevant raw blob', score: 0.9 }]);

    const result = await executeTool('search_vita_faq', { query: doc.question }, RECEPTIONIST_PERMISSIONS, hms, faqRetriever);

    expect(faqRetriever.search).toHaveBeenCalledWith(doc.question, 3);
    expect(result).toEqual([{ question: doc.question, answer: doc.answer }]);
  });

  it('allows both a receptionist-shaped and doctor-shaped session to call search_vita_faq', async () => {
    const hms = mockHms();
    for (const permissions of [RECEPTIONIST_PERMISSIONS, DOCTOR_PERMISSIONS]) {
      const faqRetriever = mockRetriever([]);
      await expect(executeTool('search_vita_faq', { query: 'what is vita' }, permissions, hms, faqRetriever)).resolves.toEqual([]);
    }
  });

  it('throws UnknownToolError for search_vita_faq when no retriever is supplied', async () => {
    const hms = mockHms();
    await expect(executeTool('search_vita_faq', { query: 'what is vita' }, RECEPTIONIST_PERMISSIONS, hms)).rejects.toThrow(UnknownToolError);
  });

  it('dispatches search_hospital_reference to the retriever and maps hits back to {title, body} pairs', async () => {
    const hms = mockHms();
    const doc = HOSPITAL_REFERENCE_DOCS[0]!;
    const hospitalReferenceRetriever = mockRetriever([{ id: doc.id, text: 'irrelevant raw blob', score: 0.9 }]);

    const result = await executeTool(
      'search_hospital_reference',
      { query: doc.title },
      RECEPTIONIST_PERMISSIONS,
      hms,
      undefined,
      hospitalReferenceRetriever,
    );

    expect(hospitalReferenceRetriever.search).toHaveBeenCalledWith(doc.title, 3);
    expect(result).toEqual([{ title: doc.title, body: doc.body }]);
  });

  it('allows both a receptionist-shaped and doctor-shaped session to call search_hospital_reference', async () => {
    const hms = mockHms();
    for (const permissions of [RECEPTIONIST_PERMISSIONS, DOCTOR_PERMISSIONS]) {
      const hospitalReferenceRetriever = mockRetriever([]);
      await expect(
        executeTool('search_hospital_reference', { query: 'visiting hours' }, permissions, hms, undefined, hospitalReferenceRetriever),
      ).resolves.toEqual([]);
    }
  });

  it('throws UnknownToolError for search_hospital_reference when no retriever is supplied', async () => {
    const hms = mockHms();
    await expect(
      executeTool('search_hospital_reference', { query: 'visiting hours' }, RECEPTIONIST_PERMISSIONS, hms),
    ).rejects.toThrow(UnknownToolError);
  });
});
