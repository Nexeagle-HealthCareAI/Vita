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
 *
 * A second family of methods (see `markAppointmentArrived` below) calls staff-only
 * [Authorize]+[RequiresPermission] endpoints instead of the anonymous public/* surface --
 * these send `Authorization: Bearer <token>` rather than the public surface's optional
 * X-Api-Key, and are deliberately kept on a SEPARATE request path (requestAsStaff, not
 * request) since the two headers represent different trust boundaries with no verified
 * interaction between them.
 *
 * The bearer token for staff-auth calls is always the REAL, currently-calling staff
 * member's own easyHMSAPI JWT, forwarded per-session from the web app they're already
 * logged into (see apps/gateway/src/ticket.ts's SessionClaims and
 * apps/orchestrator/src/session.ts's DialogueSession.hmsAccessToken) -- HmsClient never
 * mints or holds a credential of its own. That's why every staff-auth method below takes a
 * StaffAuthContext as an explicit per-call argument rather than constructor state: a single
 * HmsClient instance is shared across the whole orchestrator process, but each call belongs
 * to a different real person, possibly at a different hospital.
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

export interface HospitalRosterInput {
  hospitalId: string;
}

export interface RosterDoctor {
  doctorId: string;
  fullName: string;
  departmentName: string | null;
  specialtyCategory: string | null;
}

export interface HospitalRosterResult {
  doctors: RosterDoctor[];
}

interface RawRosterResponse {
  success: boolean;
  message: string | null;
  doctors: {
    doctorId: string;
    fullName: string | null;
    departmentName: string | null;
    specialtyCategory: string | null;
  }[];
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

export interface MarkAppointmentArrivedInput {
  appointmentId: string;
  doctorId: string;
}

export interface MarkAppointmentArrivedResult {
  success: boolean;
  message: string | null;
  tokenNo: number | null;
  status: string | null;
}

interface RawMarkArrivedResponse {
  success: boolean;
  message: string | null;
  tokenNo: number | null;
  status: string | null;
}

/** Per-call staff identity for a markAppointmentArrived-style call -- the real staff
 * member's own easyHMSAPI hospitalId + bearer JWT, forwarded from their session (see this
 * file's header comment). Never constructor/instance state. */
export interface StaffAuthContext {
  hospitalId: string;
  accessToken: string;
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

  /** Staff-auth counterpart to request() above -- sends Authorization: Bearer instead of
   * X-Api-Key, for the [Authorize]+[RequiresPermission] endpoints the anonymous public
   * surface can't reach. No retry on 401 or 403: unlike a client-minted credential, there is
   * no fresher token Vita could obtain on the real staff member's behalf -- either code means
   * their own forwarded credential is stale, revoked, or insufficient, and that's a clean
   * failure to surface, not something to paper over. */
  private async requestAsStaff<T>(path: string, init: RequestInit, staffAuth: StaffAuthContext): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffAuth.accessToken}`,
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`1HMS staff API ${path} failed: ${res.status} ${await res.text()}`);
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

  /** Hospital-wide doctor roster for LLM-side phonetic name correction (see
   * apps/orchestrator/src/doctorRoster.ts) -- NOT the same as findDoctors: this hits
   * /public/doctors/roster (DoctorDepartments membership, bypasses IsPubliclyListed) rather
   * than /public/doctors (the platform-wide opt-in marketplace directory), so it never
   * silently misses a doctor who hasn't opted into public listing. */
  async getHospitalRoster(input: HospitalRosterInput): Promise<HospitalRosterResult> {
    const qs = new URLSearchParams({ hospitalId: input.hospitalId });
    const data = await this.request<RawRosterResponse>(`/public/doctors/roster?${qs.toString()}`, { method: 'GET' });
    return {
      doctors: data.doctors.map((d) => ({
        doctorId: d.doctorId,
        fullName: d.fullName ?? 'Doctor',
        departmentName: d.departmentName,
        specialtyCategory: d.specialtyCategory,
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

  /** Reception check-in override -- issues a queue token for an appointment that already
   * exists, without the patient-side geofence check (POST public/tokens's trust model).
   * Staff-auth only: this is the proof-of-concept slice for real-staff-JWT forwarding --
   * chosen first because it's idempotent (QueueCheckInHelper.CheckInAsync: a retried call
   * for an appointment that already has a token just returns the existing one) and can only
   * act on an appointment that already exists, never create/commit new state.
   *
   * staffAuth.hospitalId is NEVER a caller-supplied LLM argument -- see StaffAuthContext's
   * doc comment. It comes from the calling staff member's own session, never from
   * transcribed/inferred voice input, so a mis-transcription can't redirect which
   * hospital's data this mutates. */
  async markAppointmentArrived(input: MarkAppointmentArrivedInput, staffAuth: StaffAuthContext): Promise<MarkAppointmentArrivedResult> {
    const body = { appointmentId: input.appointmentId, hospitalId: staffAuth.hospitalId };
    const data = await this.requestAsStaff<RawMarkArrivedResponse>(
      `/queue/${input.doctorId}/mark-arrived`,
      { method: 'POST', body: JSON.stringify(body) },
      staffAuth,
    );
    return {
      success: data.success,
      message: data.message,
      tokenNo: data.tokenNo,
      status: data.status,
    };
  }
}
