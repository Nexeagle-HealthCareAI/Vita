import { describe, expect, it } from 'vitest';
import { ForbiddenError, assertToolPermission } from '../src/rbac.js';

describe('RBAC tool permissions', () => {
  it('allows both a receptionist and a doctor to find doctors', () => {
    expect(() => assertToolPermission('find_doctors', 'ROLE_RECEPTIONIST')).not.toThrow();
    expect(() => assertToolPermission('find_doctors', 'ROLE_DOCTOR')).not.toThrow();
  });

  it('allows a receptionist to book an appointment', () => {
    expect(() => assertToolPermission('book_appointment', 'ROLE_RECEPTIONIST')).not.toThrow();
  });

  it('denies a receptionist reading EMR data', () => {
    expect(() => assertToolPermission('read_patient_emr', 'ROLE_RECEPTIONIST')).toThrow(
      ForbiddenError,
    );
  });

  it('denies a doctor calling book_appointment (out of scope for that role)', () => {
    expect(() => assertToolPermission('book_appointment', 'ROLE_DOCTOR')).toThrow(ForbiddenError);
  });

  it('denies any role for an unknown tool (deny-by-default)', () => {
    expect(() => assertToolPermission('delete_all_patients', 'ROLE_DOCTOR')).toThrow(
      ForbiddenError,
    );
  });

  it('allows both a receptionist and a doctor to search the FAQ', () => {
    expect(() => assertToolPermission('search_vita_faq', 'ROLE_RECEPTIONIST')).not.toThrow();
    expect(() => assertToolPermission('search_vita_faq', 'ROLE_DOCTOR')).not.toThrow();
  });
});
