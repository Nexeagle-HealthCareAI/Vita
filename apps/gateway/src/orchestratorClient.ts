export interface CreateSessionInput {
  sessionId: string;
  userId: string;
  consentGiven: boolean;
  /** Forwarded from ticket.ts's SessionClaims -- see that file's doc comment. */
  hospitalId?: string;
  hmsAccessToken?: string;
}

export interface TurnAudioResult {
  transcript: string; // '' on soft no-op (VAD armed an utterance but STT heard no words)
  replyText: string | null; // null iff transcript === ''
  audioBase64: string | null; // null iff transcript === ''
  toolCallsExecuted: string[];
  /** New/changed slot values from this turn (e.g. patientName, patientMobile), already
   * role-gated to ROLE_RECEPTIONIST by the orchestrator -- null when nothing changed.
   * Powers TurnBackendEvents.onFormAutofill (see turnBackend.ts). */
  formFields: Record<string, unknown> | null;
}

export interface RelayError {
  code: string;
  message: string;
  recoverable: boolean;
}

export type TurnAudioResponse = { ok: true; data: TurnAudioResult } | { ok: false; error: RelayError };

export interface OrchestratorSessionResult {
  sessionId: string;
  resumeToken: string;
}

// Same constructor-injected-fetch pattern as HmsClient/GroqClient/SarvamClient in
// apps/orchestrator -- lets tests mock this without a real HTTP call.
export class OrchestratorClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
    // Bounds every call below -- previously unbounded, so a hung/slow orchestrator could
    // freeze a live call indefinitely (createSession() in particular now gates
    // ConnectionRelay.start()'s sessionReady, which audio frames wait on -- see relay.ts).
    private timeoutMs = Number(process.env.ORCHESTRATOR_REQUEST_TIMEOUT_MS ?? 8_000),
  ) {}

  /** Never throws -- a network error, a timeout, or a malformed response body all resolve
   * null exactly like a non-2xx response does, matching resumeSession()'s existing
   * airtight-failure-path contract below (this used to be a real gap: an uncaught
   * createSession() rejection propagates out of ConnectionRelay.start(), which index.ts
   * calls as `void relay.start(...).then(...)` with no .catch() anywhere in the chain --
   * an unhandled promise rejection that could crash the whole gateway process). */
  async createSession(input: CreateSessionInput): Promise<OrchestratorSessionResult | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      // The orchestrator's POST /session response is the full session object, which
      // already includes resumeToken -- just stop dropping it on the floor.
      const body = (await res.json()) as OrchestratorSessionResult;
      return { sessionId: body.sessionId, resumeToken: body.resumeToken };
    } catch {
      return null;
    }
  }

  /** Never throws -- an ordinary invalid/expired/mismatched resume (including a
   * network-level fetch failure) resolves null exactly like a non-2xx response does, so
   * ConnectionRelay.start() can unconditionally fall back to createSession() without a
   * try/catch of its own. */
  async resumeSession(sessionId: string, resumeToken: string, userId: string): Promise<OrchestratorSessionResult | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeToken, userId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as OrchestratorSessionResult;
      return { sessionId: body.sessionId, resumeToken: body.resumeToken };
    } catch {
      return null;
    }
  }

  async postAudioTurn(sessionId: string, audio: Uint8Array): Promise<TurnAudioResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/session/${sessionId}/turn/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // See audioPreprocessClient.ts's identical cast for why.
      body: audio as unknown as BodyInit,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.ok) {
      return { ok: true, data: (await res.json()) as TurnAudioResult };
    }
    const body = (await res.json().catch(() => null)) as { error?: RelayError } | null;
    return {
      ok: false,
      error: body?.error ?? { code: 'UPSTREAM_ERROR', message: `orchestrator returned ${res.status}`, recoverable: true },
    };
  }

  /** Never throws -- a healthz check that itself needs a try/catch at every call site
   * would defeat the point. Used by this gateway's own /healthz (see index.ts) so a
   * dead/unreachable orchestrator makes THIS instance report unhealthy too, instead of
   * the gateway's trivial always-200 endpoint hiding a real outage from deploy.yml's
   * health-check gate. */
  async healthz(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
