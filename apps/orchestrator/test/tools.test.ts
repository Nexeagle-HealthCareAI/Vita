import { describe, expect, it, vi } from 'vitest';
import { HmsClient } from '@vita/mcp-1hms';
import { FAQ_DOCS, HOSPITAL_REFERENCE_DOCS } from '@vita/rag';
import { executeTool, UnknownToolError } from '../src/tools.js';
import { ForbiddenError } from '../src/rbac.js';
import { mockRetriever } from './helpers.js';

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

  it('dispatches search_vita_faq to the retriever and maps hits back to {question, answer} pairs', async () => {
    const hms = mockHms();
    const doc = FAQ_DOCS[0]!;
    const faqRetriever = mockRetriever([{ id: doc.id, text: 'irrelevant raw blob', score: 0.9 }]);

    const result = await executeTool('search_vita_faq', { query: doc.question }, 'ROLE_RECEPTIONIST', hms, faqRetriever);

    expect(faqRetriever.search).toHaveBeenCalledWith(doc.question, 3);
    expect(result).toEqual([{ question: doc.question, answer: doc.answer }]);
  });

  it('allows both a receptionist and a doctor to call search_vita_faq', async () => {
    const hms = mockHms();
    for (const role of ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'] as const) {
      const faqRetriever = mockRetriever([]);
      await expect(executeTool('search_vita_faq', { query: 'what is vita' }, role, hms, faqRetriever)).resolves.toEqual([]);
    }
  });

  it('throws UnknownToolError for search_vita_faq when no retriever is supplied', async () => {
    const hms = mockHms();
    await expect(executeTool('search_vita_faq', { query: 'what is vita' }, 'ROLE_RECEPTIONIST', hms)).rejects.toThrow(UnknownToolError);
  });

  it('dispatches search_hospital_reference to the retriever and maps hits back to {title, body} pairs', async () => {
    const hms = mockHms();
    const doc = HOSPITAL_REFERENCE_DOCS[0]!;
    const hospitalReferenceRetriever = mockRetriever([{ id: doc.id, text: 'irrelevant raw blob', score: 0.9 }]);

    const result = await executeTool(
      'search_hospital_reference',
      { query: doc.title },
      'ROLE_RECEPTIONIST',
      hms,
      undefined,
      hospitalReferenceRetriever,
    );

    expect(hospitalReferenceRetriever.search).toHaveBeenCalledWith(doc.title, 3);
    expect(result).toEqual([{ title: doc.title, body: doc.body }]);
  });

  it('allows both a receptionist and a doctor to call search_hospital_reference', async () => {
    const hms = mockHms();
    for (const role of ['ROLE_RECEPTIONIST', 'ROLE_DOCTOR'] as const) {
      const hospitalReferenceRetriever = mockRetriever([]);
      await expect(
        executeTool('search_hospital_reference', { query: 'visiting hours' }, role, hms, undefined, hospitalReferenceRetriever),
      ).resolves.toEqual([]);
    }
  });

  it('throws UnknownToolError for search_hospital_reference when no retriever is supplied', async () => {
    const hms = mockHms();
    await expect(
      executeTool('search_hospital_reference', { query: 'visiting hours' }, 'ROLE_RECEPTIONIST', hms),
    ).rejects.toThrow(UnknownToolError);
  });
});
