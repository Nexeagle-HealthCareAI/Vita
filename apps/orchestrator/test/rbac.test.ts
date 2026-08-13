import { describe, expect, it } from 'vitest';
import { ForbiddenError, assertToolPermission } from '../src/rbac.js';

describe('RBAC tool permissions', () => {
  it('allows a receptionist to register a patient', () => {
    expect(() => assertToolPermission('register_patient', 'ROLE_RECEPTIONIST')).not.toThrow();
  });

  it('denies a receptionist reading EMR data', () => {
    expect(() => assertToolPermission('read_patient_emr', 'ROLE_RECEPTIONIST')).toThrow(
      ForbiddenError,
    );
  });

  it('denies a doctor calling register_patient (out of scope for that role)', () => {
    expect(() => assertToolPermission('register_patient', 'ROLE_DOCTOR')).toThrow(ForbiddenError);
  });

  it('denies any role for an unknown tool (deny-by-default)', () => {
    expect(() => assertToolPermission('delete_all_patients', 'ROLE_DOCTOR')).toThrow(
      ForbiddenError,
    );
  });
});
