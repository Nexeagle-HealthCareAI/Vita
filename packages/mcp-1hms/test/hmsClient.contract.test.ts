import { describe, expect, it } from 'vitest';
import { HmsClient } from '../src/hmsClient.js';

/**
 * Contract test: hits a REAL, live easyHMSAPI instance (not a mock) and asserts the
 * response shapes HmsClient expects still hold. This is what actually catches drift if
 * easyHMSAPI's /public/* surface changes -- hmsClient.test.ts only proves the client
 * parses whatever shape *we* hand it, which can't detect a real API contract change.
 *
 * Excluded from the default `vitest`/`pnpm test` run via this package's vitest.config.ts
 * (it depends on an external service being up, and bookAppointment below is a real write
 * -- neither belongs in the every-PR gate). Run explicitly via `pnpm test:contract`,
 * wired into CI as a nightly + on-demand job only (see .github/workflows/ci.yml's
 * mcp-1hms-contract job), matching the audio-preprocess-slow precedent for "real,
 * external, deliberately-excluded-from-PRs" tests in this repo.
 *
 * HMS_API_BASE_URL defaults to the real dev environment (confirmed live and reachable
 * at the time this was written: http://151.185.45.77:5001) -- override via env for a
 * different target. Never point this at a prod URL.
 */
const BASE_URL = process.env.HMS_API_BASE_URL ?? 'http://151.185.45.77:5001';
const API_KEY = process.env.HMS_API_KEY ?? '';

// Obviously-fake, greppable patient identity for the one real write this file performs
// (bookAppointment) -- anyone auditing the dev DB's appointments/patients tables can
// immediately tell this row came from this test, not a real caller.
const CONTRACT_TEST_PATIENT_NAME = 'VITA-CONTRACT-TEST (safe to delete)';
const CONTRACT_TEST_PATIENT_MOBILE = '9999999000';

function futureDateString(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

describe('HmsClient contract (real easyHMSAPI)', () => {
  it(
    'findDoctors returns the real /public/doctors shape',
    async () => {
      const client = new HmsClient(BASE_URL, API_KEY);
      const result = await client.findDoctors({ pageSize: 5 });

      expect(typeof result.totalCount).toBe('number');
      expect(Array.isArray(result.doctors)).toBe(true);
      expect(result.doctors.length).toBeGreaterThan(0);

      const doctor = result.doctors[0]!;
      expect(typeof doctor.doctorId).toBe('string');
      expect(typeof doctor.fullName).toBe('string');
      expect(typeof doctor.hospitalId).toBe('string');
      expect(typeof doctor.isAvailableToday).toBe('boolean');
      // departmentName/specialtyCategory/hospitalName/city/fee are all nullable in real
      // data -- only assert they're present as a key, not truthy.
      expect('departmentName' in doctor).toBe(true);
      expect('fee' in doctor).toBe(true);
    },
    30_000,
  );

  it(
    'checkDoctorAvailability returns real shift data, not slot IDs',
    async () => {
      const client = new HmsClient(BASE_URL, API_KEY);
      const { doctors } = await client.findDoctors({ pageSize: 1 });
      expect(doctors.length).toBeGreaterThan(0);
      const doctorId = doctors[0]!.doctorId;

      const result = await client.checkDoctorAvailability({ doctorId, date: futureDateString(7) });

      expect(typeof result.isAvailable).toBe('boolean');
      expect(Array.isArray(result.shifts)).toBe(true);
      for (const shift of result.shifts) {
        expect('name' in shift).toBe(true);
        expect('startTime' in shift).toBe(true);
        expect('endTime' in shift).toBe(true);
      }
    },
    30_000,
  );

  it(
    'bookAppointment creates a real (obviously-fake, greppable) request and returns the real response shape',
    async () => {
      const client = new HmsClient(BASE_URL, API_KEY);
      const { doctors } = await client.findDoctors({ pageSize: 1 });
      expect(doctors.length).toBeGreaterThan(0);
      const doctorId = doctors[0]!.doctorId;

      const result = await client.bookAppointment({
        doctorId,
        patientName: CONTRACT_TEST_PATIENT_NAME,
        patientMobile: CONTRACT_TEST_PATIENT_MOBILE,
        preferredDate: futureDateString(14),
        reason: 'Automated contract test -- safe to ignore/delete.',
      });

      expect(typeof result.success).toBe('boolean');
      expect('message' in result).toBe(true);
      expect('appointmentId' in result).toBe(true);
      expect('patientId' in result).toBe(true);
      expect(typeof result.isReminderSent).toBe('boolean');
    },
    30_000,
  );
});
