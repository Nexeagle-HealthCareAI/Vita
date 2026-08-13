export interface RegisterPatientInput {
  name: string;
  phone: string;
  department: string;
  dob?: string;
}

export interface SlotAvailabilityInput {
  department: string;
  doctorId?: string;
  date: string; // YYYY-MM-DD
}

export interface BookAppointmentInput {
  patientId: string;
  doctorId: string;
  slotId: string;
}

/**
 * Thin typed client over the existing 1HMS ASP.NET Core API
 * (easyHMSAPI). Kept separate from the MCP tool definitions so it can be
 * unit-tested against a mocked HTTP layer without spinning up an MCP host.
 */
export class HmsClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${this.apiKey}`,
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`1HMS API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  registerPatient(input: RegisterPatientInput) {
    return this.request<{ patientId: string }>('/api/patients', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  checkSlotAvailability(input: SlotAvailabilityInput) {
    const qs = new URLSearchParams({
      department: input.department,
      date: input.date,
      ...(input.doctorId ? { doctorId: input.doctorId } : {}),
    });
    return this.request<{ slots: { slotId: string; time: string; doctorId: string }[] }>(
      `/api/slots?${qs.toString()}`,
      { method: 'GET' },
    );
  }

  bookAppointment(input: BookAppointmentInput) {
    return this.request<{ appointmentId: string }>('/api/appointments', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}
