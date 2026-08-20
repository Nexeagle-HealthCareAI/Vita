import { describe, expect, it } from 'vitest';
import { ForbiddenError, assertToolPermission, isToolAllowed, derivePersona } from '../src/rbac.js';

const RECEPTIONIST_PERMISSIONS = ['appointment_scheduler'];
const DOCTOR_PERMISSIONS = ['doc_board'];
// A real easyHMSAPI role shape the old two-value enum could never represent -- proves
// permission-key derivation, not a hardcoded role match.
const ACCOUNTANT_PERMISSIONS = ['billing'];
const NURSE_PERMISSIONS = ['appointment_scheduler', 'nursing_station', 'icu_board', 'inventory'];

describe('RBAC tool permissions (derived from real easyHMSAPI permission keys)', () => {
  it('allows any resolved session (even empty permissions) to find doctors / check availability / search -- anyOf: []', () => {
    for (const tool of ['find_doctors', 'check_doctor_availability', 'search_vita_faq', 'search_hospital_reference']) {
      expect(() => assertToolPermission(tool, [])).not.toThrow();
      expect(() => assertToolPermission(tool, RECEPTIONIST_PERMISSIONS)).not.toThrow();
      expect(() => assertToolPermission(tool, DOCTOR_PERMISSIONS)).not.toThrow();
    }
  });

  it('allows a session holding appointment_scheduler to book an appointment', () => {
    expect(() => assertToolPermission('book_appointment', RECEPTIONIST_PERMISSIONS)).not.toThrow();
  });

  it('OR semantics: appointment_booking alone (without appointment_scheduler) also allows book_appointment', () => {
    expect(() => assertToolPermission('book_appointment', ['appointment_booking'])).not.toThrow();
  });

  it('denies a doctor-shaped session (doc_board only) from booking or marking arrived', () => {
    expect(() => assertToolPermission('book_appointment', DOCTOR_PERMISSIONS)).toThrow(ForbiddenError);
    expect(() => assertToolPermission('mark_appointment_arrived', DOCTOR_PERMISSIONS)).toThrow(ForbiddenError);
  });

  it('allows a doctor-shaped session (doc_board) to use the read_patient_emr/write_clinical_note placeholder tools', () => {
    // read_patient_emr/write_clinical_note map to doc_board -- a doctor-shaped session is
    // exactly who SHOULD be allowed here (no dispatch exists yet, but the RBAC layer itself
    // should already reflect the intended real permission).
    expect(() => assertToolPermission('read_patient_emr', DOCTOR_PERMISSIONS)).not.toThrow();
    expect(() => assertToolPermission('write_clinical_note', DOCTOR_PERMISSIONS)).not.toThrow();
  });

  it('denies an accountant-shaped session (billing only) from booking, marking arrived, or EMR access', () => {
    expect(() => assertToolPermission('book_appointment', ACCOUNTANT_PERMISSIONS)).toThrow(ForbiddenError);
    expect(() => assertToolPermission('mark_appointment_arrived', ACCOUNTANT_PERMISSIONS)).toThrow(ForbiddenError);
    expect(() => assertToolPermission('read_patient_emr', ACCOUNTANT_PERMISSIONS)).toThrow(ForbiddenError);
    // Still allowed -- these require no specific permission (anyOf: []).
    expect(() => assertToolPermission('find_doctors', ACCOUNTANT_PERMISSIONS)).not.toThrow();
  });

  it('allows a nurse-shaped session (multi-permission bundle, never representable by the old 2-value enum) to book and mark arrived', () => {
    expect(() => assertToolPermission('book_appointment', NURSE_PERMISSIONS)).not.toThrow();
    expect(() => assertToolPermission('mark_appointment_arrived', NURSE_PERMISSIONS)).not.toThrow();
  });

  it('allows a session holding appointment_scheduler to mark an appointment arrived', () => {
    expect(() => assertToolPermission('mark_appointment_arrived', RECEPTIONIST_PERMISSIONS)).not.toThrow();
  });

  it('an unrelated/custom key does not fuzzy-match -- exact-string OR-only, no prefix/substring matching', () => {
    expect(() => assertToolPermission('book_appointment', ['front_desk_v2'])).toThrow(ForbiddenError);
    expect(() => assertToolPermission('book_appointment', ['appointment_scheduler_readonly'])).toThrow(ForbiddenError);
  });

  it('denies any permission set for an unknown tool (deny-by-default)', () => {
    expect(() => assertToolPermission('delete_all_patients', ['admin_panel', 'appointment_scheduler', 'billing'])).toThrow(
      ForbiddenError,
    );
  });
});

describe('isToolAllowed (non-throwing counterpart, used for upfront filtering)', () => {
  it('mirrors assertToolPermission for a shared (anyOf: []) tool -- true regardless of permissions', () => {
    expect(isToolAllowed('find_doctors', [])).toBe(true);
    expect(isToolAllowed('find_doctors', DOCTOR_PERMISSIONS)).toBe(true);
  });

  it('mirrors assertToolPermission for a permission-gated tool', () => {
    expect(isToolAllowed('book_appointment', RECEPTIONIST_PERMISSIONS)).toBe(true);
    expect(isToolAllowed('book_appointment', DOCTOR_PERMISSIONS)).toBe(false);
  });

  it('mirrors assertToolPermission for mark_appointment_arrived', () => {
    expect(isToolAllowed('mark_appointment_arrived', RECEPTIONIST_PERMISSIONS)).toBe(true);
    expect(isToolAllowed('mark_appointment_arrived', DOCTOR_PERMISSIONS)).toBe(false);
  });

  it('is deny-by-default for an unknown tool, regardless of how many permissions are held', () => {
    expect(isToolAllowed('delete_all_patients', ['admin_panel', 'appointment_scheduler'])).toBe(false);
  });
});

describe('derivePersona (UX-only bucketing, never an authorization input)', () => {
  it('buckets doc_board-holding permission sets as ROLE_DOCTOR', () => {
    expect(derivePersona(DOCTOR_PERMISSIONS)).toBe('ROLE_DOCTOR');
    expect(derivePersona(['doc_board', 'ipd'])).toBe('ROLE_DOCTOR');
  });

  it('buckets everything else -- receptionist, accountant, nurse, empty -- as ROLE_RECEPTIONIST', () => {
    expect(derivePersona(RECEPTIONIST_PERMISSIONS)).toBe('ROLE_RECEPTIONIST');
    expect(derivePersona(ACCOUNTANT_PERMISSIONS)).toBe('ROLE_RECEPTIONIST');
    expect(derivePersona(NURSE_PERMISSIONS)).toBe('ROLE_RECEPTIONIST');
    expect(derivePersona([])).toBe('ROLE_RECEPTIONIST');
  });

  it('bucketing an accountant/nurse as ROLE_RECEPTIONIST does NOT itself grant book_appointment or mark_appointment_arrived -- that is isToolAllowed\'s independent job, never persona', () => {
    expect(derivePersona(ACCOUNTANT_PERMISSIONS)).toBe('ROLE_RECEPTIONIST');
    expect(isToolAllowed('book_appointment', ACCOUNTANT_PERMISSIONS)).toBe(false);
    expect(isToolAllowed('mark_appointment_arrived', ACCOUNTANT_PERMISSIONS)).toBe(false);

    // The nurse case is the interesting one: same persona bucket as the accountant, but a
    // genuinely different real capability -- proving persona and authorization are fully
    // decoupled, not just "usually correlated."
    expect(derivePersona(NURSE_PERMISSIONS)).toBe('ROLE_RECEPTIONIST');
    expect(isToolAllowed('book_appointment', NURSE_PERMISSIONS)).toBe(true);
  });
});
