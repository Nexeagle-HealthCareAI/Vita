import { describe, expect, it } from 'vitest';
import { HmsClient } from '../src/hmsClient.js';
import { HmsAuthClient } from '../src/hmsAuthClient.js';

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

// Staff-auth contract case (markAppointmentArrived) needs a REAL provisioned
// VitaServiceAccount credential plus a stable, pre-existing (non-PRE_APPOINTMENT) dev
// appointment to target -- neither can be created/discovered by this test itself (unlike
// bookAppointment above, mark-arrived can't safely manufacture its own disposable fixture
// without also faking a realistic prior booking flow). Skips entirely until an operator has
// provisioned the per-hospital Vita service User (see
// easyHMSDatabase/db/data/seed/seed_vita_service_role.sql's doc comment) and set these.
const STAFF_LOGIN = process.env.VITA_HMS_STAFF_LOGIN;
const STAFF_PASSWORD = process.env.VITA_HMS_STAFF_PASSWORD;
const STAFF_TEST_APPOINTMENT_ID = process.env.VITA_HMS_STAFF_TEST_APPOINTMENT_ID;
const STAFF_TEST_DOCTOR_ID = process.env.VITA_HMS_STAFF_TEST_DOCTOR_ID;
const STAFF_TEST_HOSPITAL_ID = process.env.VITA_HMS_STAFF_TEST_HOSPITAL_ID;
const staffContractConfigured = Boolean(
  STAFF_LOGIN && STAFF_PASSWORD && STAFF_TEST_APPOINTMENT_ID && STAFF_TEST_DOCTOR_ID && STAFF_TEST_HOSPITAL_ID,
);

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
    'getHospitalRoster returns the real /public/doctors/roster shape',
    async () => {
      const client = new HmsClient(BASE_URL, API_KEY);
      const { doctors } = await client.findDoctors({ pageSize: 1 });
      expect(doctors.length).toBeGreaterThan(0);
      const hospitalId = doctors[0]!.hospitalId;

      const result = await client.getHospitalRoster({ hospitalId });

      expect(Array.isArray(result.doctors)).toBe(true);
      expect(result.doctors.length).toBeGreaterThan(0);
      const doctor = result.doctors[0]!;
      expect(typeof doctor.doctorId).toBe('string');
      expect(typeof doctor.fullName).toBe('string');
      expect('departmentName' in doctor).toBe(true);
      expect('specialtyCategory' in doctor).toBe(true);
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

  it.skipIf(!staffContractConfigured)(
    'markAppointmentArrived returns the real /queue/{doctorId}/mark-arrived shape (staff-auth) -- idempotent, safe to re-run',
    async () => {
      const authClient = new HmsAuthClient(BASE_URL, { login: STAFF_LOGIN!, password: STAFF_PASSWORD! }, 86_400_000);
      const client = new HmsClient(BASE_URL, API_KEY, undefined, { authClient, hospitalId: STAFF_TEST_HOSPITAL_ID });

      const result = await client.markAppointmentArrived({
        appointmentId: STAFF_TEST_APPOINTMENT_ID!,
        doctorId: STAFF_TEST_DOCTOR_ID!,
      });

      expect(typeof result.success).toBe('boolean');
      expect('message' in result).toBe(true);
      expect('tokenNo' in result).toBe(true);
      expect('status' in result).toBe(true);

      authClient.stop();
    },
    30_000,
  );
});
