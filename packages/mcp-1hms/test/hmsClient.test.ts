import { describe, expect, it, vi } from 'vitest';
import { HmsClient } from '../src/hmsClient.js';

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
});
