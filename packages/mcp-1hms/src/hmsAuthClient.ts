/**
 * Mints and caches a staff-equivalent JWT for Vita's own "service" identity (a real
 * per-hospital User provisioned via easyHMSAPI's existing POST admin/users/quick-add flow,
 * holding a bespoke VitaServiceAccount Role scoped to exactly {appointment_scheduler,
 * patients} -- see easyHMSDatabase/db/data/seed/seed_vita_service_role.sql).
 *
 * easyHMSAPI has no refresh-token/rotation mechanism (JwtAuthService issues a flat 30-day
 * bearer JWT from a single POST auth/user/login call) -- so staying authenticated here means
 * periodically repeating that same login call a human would make, well inside the 30-day
 * window, and caching the result in memory. Deliberately PROACTIVE, not reactive-on-401:
 * buildServer() composes a live, latency-sensitive voice pipeline, and a request-path login
 * call would (a) add a synchronous HTTP round trip to whichever tool call is unlucky enough
 * to hit an expired token, and (b) thundering-herd multiple concurrent tool calls into
 * simultaneous logins if several race in right after expiry. Proactive refresh on a timer
 * means getToken() on the hot path only ever reads an already-resolved in-memory value.
 */

export interface HmsStaffCredentials {
  /** Emailed or mobile login for the per-hospital "Vita service" User. */
  login: string;
  password: string;
}

interface RawLoginResponse {
  success: boolean | null;
  message: string | null;
  userId: string | null;
  accessToken: string | null;
}

export class HmsAuthClient {
  private cachedToken: string | undefined;
  private refreshPromise: Promise<string> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private baseUrl: string,
    private credentials: HmsStaffCredentials,
    private refreshIntervalMs: number,
    private fetchImpl: typeof fetch = fetch,
  ) {
    // Fired-and-forgotten, same idiom as index.ts's rosterTextPromise -- construction stays
    // synchronous (this class is built at buildServer() composition-root time, which many
    // existing tests call without `await`) while the first login happens in the background.
    this.refreshPromise = this.login();
    this.timer = setInterval(() => {
      void this.login();
    }, this.refreshIntervalMs);
    // Never keep the process alive solely to re-run this timer (matters for test/CLI
    // runs and graceful shutdown) -- Node-only guard, unref() doesn't exist in browser
    // fetch/timer typings some of this monorepo's tsconfigs target.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Resolves to the current cached token. On first call, awaits the in-flight initial
   * login. If a later scheduled refresh fails, the previous (still within its own 30-day
   * validity) token keeps being served -- see login()'s catch branch. Only rejects if no
   * login has EVER succeeded yet. */
  async getToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    if (this.refreshPromise) return this.refreshPromise;
    // Should be unreachable (refreshPromise is always set in the constructor and only
    // cleared once cachedToken is set), but forceRefresh() below is a public escape hatch
    // for HmsClient's 401 backstop, so guard defensively rather than assume.
    return this.login();
  }

  /** Reactive backstop for HmsClient's single-retry-on-401 path (see hmsClient.ts's
   * requestAsStaff) -- forces exactly one fresh login rather than waiting for the next
   * scheduled refresh. Never called on a 403 (a permission/hospital denial, not a stale
   * token) -- retrying that can't help and would just mask a live revocation event. */
  async forceRefresh(): Promise<string> {
    return this.login();
  }

  private async login(): Promise<string> {
    const promise = (async () => {
      const res = await this.fetchImpl(`${this.baseUrl}/auth/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailOrPhone: this.credentials.login,
          password: this.credentials.password,
          isLoginWithOtp: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`1HMS staff login failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as RawLoginResponse;
      if (!data.success || !data.accessToken) {
        throw new Error(`1HMS staff login failed: ${data.message ?? 'no accessToken in response'}`);
      }
      return data.accessToken;
    })();

    this.refreshPromise = promise;
    try {
      const token = await promise;
      this.cachedToken = token;
      return token;
    } catch (err) {
      // Asymmetric on purpose: a failed refresh keeps serving whatever token is already
      // cached (still valid until ITS OWN 30-day mark) rather than crash-looping the
      // process over a transient login outage. Only a caller with no cached token yet
      // (first-ever login failed) actually sees this rejection.
      console.error(
        JSON.stringify({
          type: 'VITA_HMS_STAFF_TOKEN_REFRESH_FAILED',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      if (this.cachedToken) return this.cachedToken;
      throw err;
    }
  }

  /** Test/shutdown hook -- stops the background refresh timer. Not called in production
   * (the orchestrator process lives for the timer's whole lifetime by design), but without
   * this a vitest run leaves a dangling interval per HmsAuthClient constructed in a test. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
