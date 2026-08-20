import { describe, expect, it, vi } from 'vitest';
import { HmsClient } from '../src/hmsClient.js';
import type { StaffAuthContext } from '../src/hmsClient.js';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

describe('HmsClient', () => {
  it('findDoctors queries /public/doctors with the given filters and maps the response', async () => {
    const fetchImpl = fakeFetch({
      doctors: [
        {
          doctorId: 'd-1',
          fullName: 'Dr. Priya Sharma',
          departmentName: 'Cardiology',
          primaryMedicalSpecialityCategory: 'Cardiology',
          hospitalId: 'h-1',
          hospitalName: 'Apollo Test',
          city: 'Kolkata',
          fee: 500,
          isAvailableToday: true,
        },
      ],
      totalCount: 1,
    });
    const client = new HmsClient('https://hms.internal', 'key', fetchImpl);

    const result = await client.findDoctors({ specialtyCategory: 'Cardiology' });

    expect(result.totalCount).toBe(1);
    expect(result.doctors[0]).toEqual({
      doctorId: 'd-1',
      fullName: 'Dr. Priya Sharma',
      departmentName: 'Cardiology',
      specialtyCategory: 'Cardiology',
      hospitalId: 'h-1',
      hospitalName: 'Apollo Test',
      city: 'Kolkata',
      fee: 500,
      isAvailableToday: true,
    });
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/public/doctors?');
    expect(url).toContain('specialtyCategory=Cardiology');
  });

  it('getHospitalRoster queries /public/doctors/roster with hospitalId and maps the response', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      message: null,
      doctors: [
        { doctorId: 'd-1', fullName: 'Anita Sharma', departmentName: 'Cardiology', specialtyCategory: 'Cardiology' },
        { doctorId: 'd-2', fullName: null, departmentName: null, specialtyCategory: null },
      ],
    });
    const client = new HmsClient('https://hms.internal', 'key', fetchImpl);

    const result = await client.getHospitalRoster({ hospitalId: 'h-1' });

    expect(result.doctors).toEqual([
      { doctorId: 'd-1', fullName: 'Anita Sharma', departmentName: 'Cardiology', specialtyCategory: 'Cardiology' },
      { doctorId: 'd-2', fullName: 'Doctor', departmentName: null, specialtyCategory: null },
    ]);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/public/doctors/roster?');
    expect(url).toContain('hospitalId=h-1');
  });

  it('checkDoctorAvailability queries /public/doctors/{id}/availability and returns shifts, not slots', async () => {
    const fetchImpl = fakeFetch({
      isAvailable: true,
      reason: null,
      shifts: [{ name: 'Morning', startTime: '09:00:00', endTime: '13:00:00' }],
    });
    const client = new HmsClient('https://hms.internal', 'key', fetchImpl);

    const result = await client.checkDoctorAvailability({ doctorId: 'd-1', date: '2026-08-20' });

    expect(result.isAvailable).toBe(true);
    expect(result.shifts).toEqual([{ name: 'Morning', startTime: '09:00:00', endTime: '13:00:00' }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/public/doctors/d-1/availability?date=2026-08-20'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('bookAppointment posts patient + doctor + preferred date/time to /public/appointments (no slotId, no separate registration)', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      message: 'Your appointment request has been received.',
      appointmentId: 'a-1',
      patientId: 'p-1',
      isReminderSent: true,
    });
    const client = new HmsClient('https://hms.internal', 'key', fetchImpl);

    const result = await client.bookAppointment({
      doctorId: 'd-1',
      patientName: 'Test Patient',
      patientMobile: '9999999999',
      preferredDate: '2026-08-20',
      reason: 'Chest pain',
    });

    expect(result).toEqual({
      success: true,
      message: 'Your appointment request has been received.',
      appointmentId: 'a-1',
      patientId: 'p-1',
      isReminderSent: true,
    });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://hms.internal/public/appointments');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      patient: { fullName: 'Test Patient', mobile: '9999999999' },
      doctorId: 'd-1',
      preferredDate: '2026-08-20',
      preferredTime: null,
      reason: 'Chest pain',
    });
  });

  it('throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ error: 'bad request' }, false, 400);
    const client = new HmsClient('https://hms.internal', 'key', fetchImpl);
    await expect(
      client.checkDoctorAvailability({ doctorId: 'd-1', date: '2026-08-20' }),
    ).rejects.toThrow(/400/);
  });

  it('sends X-Api-Key only when a key is configured', async () => {
    const fetchImpl = fakeFetch({ doctors: [], totalCount: 0 });
    const client = new HmsClient('https://hms.internal', '', fetchImpl);
    await client.findDoctors({});
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty('X-Api-Key');
  });

  describe('markAppointmentArrived (staff-auth, real per-user forwarded JWT)', () => {
    const staffAuth: StaffAuthContext = { hospitalId: 'h-1', accessToken: 'real-user-token' };

    it('posts to /queue/{doctorId}/mark-arrived with Authorization: Bearer <the forwarded token>, never X-Api-Key, and maps the response', async () => {
      const fetchImpl = fakeFetch({ success: true, message: null, tokenNo: 7, status: 'READY' });
      const client = new HmsClient('https://hms.internal', 'some-api-key', fetchImpl);

      const result = await client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' }, staffAuth);

      expect(result).toEqual({ success: true, message: null, tokenNo: 7, status: 'READY' });
      const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://hms.internal/queue/d-1/mark-arrived');
      const initTyped = init as RequestInit;
      expect((initTyped.headers as Record<string, string>).Authorization).toBe('Bearer real-user-token');
      expect(initTyped.headers).not.toHaveProperty('X-Api-Key');
      expect(JSON.parse(initTyped.body as string)).toEqual({ appointmentId: 'a-1', hospitalId: 'h-1' });
    });

    it('a 401 (stale/bad forwarded token) fails immediately -- no retry, Vita has no fresher token to obtain on the caller\'s behalf', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}), text: async () => 'expired' });
      const client = new HmsClient('https://hms.internal', '', fetchImpl as unknown as typeof fetch);

      await expect(client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' }, staffAuth)).rejects.toThrow(/401/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('a 403 (permission/hospital denial) also fails immediately with no retry', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}), text: async () => 'forbidden' });
      const client = new HmsClient('https://hms.internal', '', fetchImpl as unknown as typeof fetch);

      await expect(client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' }, staffAuth)).rejects.toThrow(/403/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('getUserPermissions (RBAC source of truth, staff-auth, self-only)', () => {
    it('queries /user/permissions with Authorization: Bearer and maps the response', async () => {
      const fetchImpl = fakeFetch({ permissionKeys: ['appointment_scheduler', 'patients'], hospitalId: 'h-1', forbidden: false });
      const client = new HmsClient('https://hms.internal', '', fetchImpl);

      const result = await client.getUserPermissions('u-1', 'real-user-token');

      expect(result).toEqual({ permissionKeys: ['appointment_scheduler', 'patients'], hospitalId: 'h-1' });
      const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://hms.internal/user/permissions?userId=u-1');
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer real-user-token');
    });

    it('resolves to an empty permission set (not a throw) when the body is a literal null (user not found/no roles)', async () => {
      const fetchImpl = fakeFetch(null);
      const client = new HmsClient('https://hms.internal', '', fetchImpl);

      const result = await client.getUserPermissions('u-1', 'real-user-token');

      expect(result).toEqual({ permissionKeys: [], hospitalId: null });
    });

    it('resolves to an empty permission set (not a throw) when the server unexpectedly reports forbidden', async () => {
      const fetchImpl = fakeFetch({ permissionKeys: ['admin_panel'], hospitalId: 'h-1', forbidden: true });
      const client = new HmsClient('https://hms.internal', '', fetchImpl);

      const result = await client.getUserPermissions('u-1', 'real-user-token');

      expect(result).toEqual({ permissionKeys: [], hospitalId: null });
    });

    it('a real HTTP failure still throws (distinct from the null/forbidden soft-empty cases)', async () => {
      const fetchImpl = fakeFetch({ error: 'bad request' }, false, 400);
      const client = new HmsClient('https://hms.internal', '', fetchImpl);

      await expect(client.getUserPermissions('u-1', 'real-user-token')).rejects.toThrow(/400/);
    });
  });
});
