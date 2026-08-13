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
  it('registerPatient posts to /api/patients and returns the patientId', async () => {
    const fetchImpl = fakeFetch({ patientId: 'p-123' });
    const client = new HmsClient('https://hms.internal', 'key', fetchImpl);
    const result = await client.registerPatient({
      name: 'Test Patient',
      phone: '9999999999',
      department: 'Cardiology',
    });
    expect(result.patientId).toBe('p-123');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hms.internal/api/patients',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ error: 'bad request' }, false, 400);
    const client = new HmsClient('https://hms.internal', 'key', fetchImpl);
    await expect(
      client.checkSlotAvailability({ department: 'Cardiology', date: '2026-08-20' }),
    ).rejects.toThrow(/400/);
  });
});
