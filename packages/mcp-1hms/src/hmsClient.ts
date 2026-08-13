/**
 * Thin typed client over the real 1HMS (easyHMSAPI) public API. Kept separate from the
 * MCP tool definitions so it can be unit-tested against a mocked HTTP layer without
 * spinning up an MCP host.
 *
 * Reshaped to match easyHMSAPI's actual public/* surface (verified directly against its
 * source, not guessed) -- the original version targeted /api/patients, /api/slots,
 * /api/appointments, none of which exist. Two real-world constraints that shape this:
 *   1. There is NO standalone patient-registration endpoint. A public booking creates
 *      (or matches) the patient inline -- see bookAppointment's `patientName`/
 *      `patientMobile` fields, not a separate registerPatient call.
 *   2. There is NO slot-reservation system. A public booking is a non-binding
 *      PreferredDate/PreferredTime request; the real StartAt is set by staff later.
 *      "Availability" only ever means "is this doctor generally working that day" (a
 *      list of named shift windows), never a discrete bookable slot ID.
 */

export interface FindDoctorsInput {
  /** Matches easyHMSAPI's dbo.MedicalSpecialities.PatientFacingCategory verbatim, e.g. "Cardiology". */
  specialtyCategory?: string;
  city?: string;
  search?: string;
  pageSize?: number;
}

export interface DoctorSummary {
  doctorId: string;
  fullName: string;
  departmentName: string | null;
  specialtyCategory: string | null;
  hospitalId: string;
  hospitalName: string | null;
  city: string | null;
  fee: number | null;
  isAvailableToday: boolean;
}

export interface FindDoctorsResult {
  doctors: DoctorSummary[];
  totalCount: number;
}

export interface CheckDoctorAvailabilityInput {
  doctorId: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface AvailabilityShift {
  name: string | null;
  /** "HH:MM:SS", .NET TimeSpan's default JSON constant format. */
  startTime: string | null;
  endTime: string | null;
}

export interface CheckDoctorAvailabilityResult {
  isAvailable: boolean;
  reason: string | null;
  shifts: AvailabilityShift[];
}

export interface BookAppointmentInput {
  doctorId: string;
  patientName: string;
  patientMobile: string;
  /** YYYY-MM-DD */
  preferredDate: string;
  /** Optional, non-binding -- "HH:MM:SS". Omit if the caller has no specific preference. */
  preferredTime?: string;
  reason?: string;
}

export interface BookAppointmentResult {
  success: boolean;
  message: string | null;
  appointmentId: string | null;
  patientId: string | null;
  isReminderSent: boolean;
}

interface RawDoctorsResponse {
  doctors: {
    doctorId: string;
    fullName: string | null;
    departmentName: string | null;
    primaryMedicalSpecialityCategory: string | null;
    hospitalId: string;
    hospitalName: string | null;
    city: string | null;
    fee: number | null;
    isAvailableToday: boolean;
  }[];
  totalCount: number;
}

interface RawAvailabilityResponse {
  isAvailable: boolean;
  reason: string | null;
  shifts: { name: string | null; startTime: string | null; endTime: string | null }[];
}

interface RawBookAppointmentResponse {
  success: boolean;
  message: string | null;
  appointmentId: string | null;
  patientId: string | null;
  isReminderSent: boolean;
}

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
        // Optional (PublicApiKeyFilter lets anonymous callers through) -- only sent
        // when set, so this client works either way.
        ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`1HMS API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async findDoctors(input: FindDoctorsInput): Promise<FindDoctorsResult> {
    const qs = new URLSearchParams();
    if (input.specialtyCategory) qs.set('specialtyCategory', input.specialtyCategory);
    if (input.city) qs.set('city', input.city);
    if (input.search) qs.set('search', input.search);
    qs.set('pageSize', String(input.pageSize ?? 10));

    const data = await this.request<RawDoctorsResponse>(`/public/doctors?${qs.toString()}`, { method: 'GET' });
    return {
      totalCount: data.totalCount,
      doctors: data.doctors.map((d) => ({
        doctorId: d.doctorId,
        fullName: d.fullName ?? 'Doctor',
        departmentName: d.departmentName,
        specialtyCategory: d.primaryMedicalSpecialityCategory,
        hospitalId: d.hospitalId,
        hospitalName: d.hospitalName,
        city: d.city,
        fee: d.fee,
        isAvailableToday: d.isAvailableToday,
      })),
    };
  }

  async checkDoctorAvailability(input: CheckDoctorAvailabilityInput): Promise<CheckDoctorAvailabilityResult> {
    const qs = new URLSearchParams({ date: input.date });
    const data = await this.request<RawAvailabilityResponse>(
      `/public/doctors/${input.doctorId}/availability?${qs.toString()}`,
      { method: 'GET' },
    );
    return { isAvailable: data.isAvailable, reason: data.reason, shifts: data.shifts };
  }

  async bookAppointment(input: BookAppointmentInput): Promise<BookAppointmentResult> {
    const body = {
      patient: { fullName: input.patientName, mobile: input.patientMobile },
      doctorId: input.doctorId,
      preferredDate: input.preferredDate,
      preferredTime: input.preferredTime ?? null,
      reason: input.reason ?? null,
    };
    const data = await this.request<RawBookAppointmentResponse>('/public/appointments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return {
      success: data.success,
      message: data.message,
      appointmentId: data.appointmentId,
      patientId: data.patientId,
      isReminderSent: data.isReminderSent,
    };
  }
}
