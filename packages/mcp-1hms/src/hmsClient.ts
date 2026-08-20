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
 * these send `Authorization: Bearer <token>` (via an injected HmsAuthClient) rather than
 * the public surface's optional X-Api-Key, and are deliberately kept on a SEPARATE request
 * path (requestAsStaff, not request) since the two headers represent different trust
 * boundaries with no verified interaction between them.
 */
import type { HmsAuthClient } from './hmsAuthClient.js';

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

export interface HmsClientStaffOptions {
  authClient?: HmsAuthClient;
  /** This deployment's single 1HMS HospitalId -- staff-auth methods are inherently
   * single-hospital-per-deployment (the Vita service User provisioned for auth only ever
   * has a HospitalUser row for one hospital), same scope as index.ts's HOSPITAL_ID used
   * for doctor-roster injection. */
  hospitalId?: string;
}

export class HmsClient {
  private authClient?: HmsAuthClient;
  private staffHospitalId?: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    staffOptions?: HmsClientStaffOptions,
  ) {
    this.authClient = staffOptions?.authClient;
    this.staffHospitalId = staffOptions?.hospitalId;
  }

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
   * surface can't reach. A 401 (stale/bad token) triggers exactly one forced re-login and
   * retry; a 403 (right identity, wrong permission/hospital -- e.g. HospitalAccessFilter or
   * PermissionAuthorizationFilter denying the request) never retries, since retrying can't
   * fix a permission problem and would just mask a live credential-revocation event (see
   * seed_vita_service_role.sql's incident-response doc comment). */
  private async requestAsStaff<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.authClient) {
      throw new Error(`1HMS staff API ${path} called with no HmsAuthClient configured -- staff auth is not set up for this deployment.`);
    }
    const authClient = this.authClient;

    const send = async (token: string) =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
      });

    let token = await authClient.getToken();
    let res = await send(token);

    if (res.status === 401) {
      token = await authClient.forceRefresh();
      res = await send(token);
    }

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
   * Staff-auth only: this is the proof-of-concept slice for Vita's staff-equivalent
   * credential (see the plan's "first proof-of-concept slice" section) -- chosen first
   * because it's idempotent (QueueCheckInHelper.CheckInAsync: a retried call for an
   * appointment that already has a token just returns the existing one) and can only act
   * on an appointment that already exists, never create/commit new state.
   *
   * hospitalId is NOT a caller-supplied argument -- see HmsClientStaffOptions.hospitalId's
   * doc comment for why this is deployment-scoped config, not per-call LLM-supplied data
   * (the LLM's transcribed/inferred values should never decide which hospital's data this
   * mutates). Throws if staff auth isn't configured for this deployment at all. */
  async markAppointmentArrived(input: MarkAppointmentArrivedInput): Promise<MarkAppointmentArrivedResult> {
    if (!this.staffHospitalId) {
      throw new Error('markAppointmentArrived called with no staff hospitalId configured for this deployment.');
    }
    const body = { appointmentId: input.appointmentId, hospitalId: this.staffHospitalId };
    const data = await this.requestAsStaff<RawMarkArrivedResponse>(`/queue/${input.doctorId}/mark-arrived`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return {
      success: data.success,
      message: data.message,
      tokenNo: data.tokenNo,
      status: data.status,
    };
  }
}
