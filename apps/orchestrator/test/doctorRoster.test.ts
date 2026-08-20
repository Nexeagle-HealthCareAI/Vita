import { describe, expect, it, vi } from 'vitest';
import { formatRosterText, fetchRosterText } from '../src/doctorRoster.js';
import { mockHms } from './helpers.js';

describe('formatRosterText', () => {
  it('returns an empty string for an empty roster', () => {
    expect(formatRosterText([])).toBe('');
  });

  it('formats one entry as "Name (Department)"', () => {
    const text = formatRosterText([{ doctorId: 'd-1', fullName: 'Anita Sharma', departmentName: 'Cardiology', specialtyCategory: 'Cardiology' }]);
    expect(text).toBe('Anita Sharma (Cardiology)');
  });

  it('omits the parens entirely when departmentName is null', () => {
    const text = formatRosterText([{ doctorId: 'd-1', fullName: 'Anita Sharma', departmentName: null, specialtyCategory: null }]);
    expect(text).toBe('Anita Sharma');
  });

  it('joins multiple entries with "; "', () => {
    const text = formatRosterText([
      { doctorId: 'd-1', fullName: 'Anita Sharma', departmentName: 'Cardiology', specialtyCategory: null },
      { doctorId: 'd-2', fullName: 'Rajesh Kumar', departmentName: 'Orthopedics', specialtyCategory: null },
    ]);
    expect(text).toBe('Anita Sharma (Cardiology); Rajesh Kumar (Orthopedics)');
  });

  it('caps the formatted list at MAX_ROSTER_DOCTORS (200)', () => {
    const doctors = Array.from({ length: 250 }, (_, i) => ({
      doctorId: `d-${i}`,
      fullName: `Doctor ${i}`,
      departmentName: null,
      specialtyCategory: null,
    }));
    const text = formatRosterText(doctors);
    expect(text.split('; ')).toHaveLength(200);
    expect(text).not.toContain('Doctor 249');
  });
});

describe('fetchRosterText', () => {
  it('returns formatted roster text on success', async () => {
    const hms = mockHms();
    hms.getHospitalRoster = vi.fn().mockResolvedValue({
      doctors: [{ doctorId: 'd-1', fullName: 'Anita Sharma', departmentName: 'Cardiology', specialtyCategory: null }],
    });

    const text = await fetchRosterText(hms, 'hosp-1');

    expect(text).toBe('Anita Sharma (Cardiology)');
    expect(hms.getHospitalRoster).toHaveBeenCalledWith({ hospitalId: 'hosp-1' });
  });

  it('returns undefined (not an empty string) for an empty roster', async () => {
    const hms = mockHms();
    hms.getHospitalRoster = vi.fn().mockResolvedValue({ doctors: [] });

    const text = await fetchRosterText(hms, 'hosp-1');

    expect(text).toBeUndefined();
  });

  it('swallows a thrown error, logs it, and resolves to undefined -- never rejects', async () => {
    const hms = mockHms();
    hms.getHospitalRoster = vi.fn().mockRejectedValue(new Error('easyHMSAPI unreachable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const text = await fetchRosterText(hms, 'hosp-1');

    expect(text).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"type":"DOCTOR_ROSTER_FETCH_FAILED"'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('easyHMSAPI unreachable'));
    errorSpy.mockRestore();
  });
});
