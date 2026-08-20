import { describe, expect, it, vi } from 'vitest';
import { HmsClient } from '../src/hmsClient.js';
import type { HmsAuthClient } from '../src/hmsAuthClient.js';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

function fakeAuthClient(token = 'token-1', refreshedToken = 'token-2') {
  return {
    getToken: vi.fn().mockResolvedValue(token),
    forceRefresh: vi.fn().mockResolvedValue(refreshedToken),
  } as unknown as HmsAuthClient;
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

  describe('markAppointmentArrived (staff-auth)', () => {
    it('posts to /queue/{doctorId}/mark-arrived with Authorization: Bearer, never X-Api-Key, and maps the response', async () => {
      const fetchImpl = fakeFetch({ success: true, message: null, tokenNo: 7, status: 'READY' });
      const authClient = fakeAuthClient('token-1');
      const client = new HmsClient('https://hms.internal', 'some-api-key', fetchImpl, {
        authClient,
        hospitalId: 'h-1',
      });

      const result = await client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' });

      expect(result).toEqual({ success: true, message: null, tokenNo: 7, status: 'READY' });
      expect(authClient.getToken).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://hms.internal/queue/d-1/mark-arrived');
      const initTyped = init as RequestInit;
      expect((initTyped.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
      expect(initTyped.headers).not.toHaveProperty('X-Api-Key');
      expect(JSON.parse(initTyped.body as string)).toEqual({ appointmentId: 'a-1', hospitalId: 'h-1' });
    });

    it('throws a clear configuration error when no authClient is set, without sending a request', async () => {
      const fetchImpl = fakeFetch({});
      const client = new HmsClient('https://hms.internal', '', fetchImpl, { hospitalId: 'h-1' });

      await expect(client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' })).rejects.toThrow(
        /no HmsAuthClient configured/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws a clear configuration error when no staff hospitalId is set, without sending a request', async () => {
      const fetchImpl = fakeFetch({});
      const authClient = fakeAuthClient();
      const client = new HmsClient('https://hms.internal', '', fetchImpl, { authClient });

      await expect(client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' })).rejects.toThrow(
        /no staff hospitalId configured/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('a 401 triggers exactly one forced re-login and retry, then succeeds', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}), text: async () => 'expired' })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true, message: null, tokenNo: 3, status: 'READY' }),
          text: async () => '',
        });
      const authClient = fakeAuthClient('stale-token', 'fresh-token');
      const client = new HmsClient('https://hms.internal', '', fetchImpl as unknown as typeof fetch, {
        authClient,
        hospitalId: 'h-1',
      });

      const result = await client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' });

      expect(result.success).toBe(true);
      expect(authClient.forceRefresh).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const secondInit = fetchImpl.mock.calls[1][1] as RequestInit;
      expect((secondInit.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
    });

    it('a 403 never retries -- retrying a permission denial can only mask a live revocation', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => 'forbidden',
      });
      const authClient = fakeAuthClient('token-1');
      const client = new HmsClient('https://hms.internal', '', fetchImpl as unknown as typeof fetch, {
        authClient,
        hospitalId: 'h-1',
      });

      await expect(client.markAppointmentArrived({ appointmentId: 'a-1', doctorId: 'd-1' })).rejects.toThrow(/403/);
      expect(authClient.forceRefresh).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
