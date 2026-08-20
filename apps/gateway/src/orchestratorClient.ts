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
  ) {}

  async createSession(input: CreateSessionInput): Promise<OrchestratorSessionResult | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    // The orchestrator's POST /session response is the full session object, which
    // already includes resumeToken -- just stop dropping it on the floor.
    const body = (await res.json()) as OrchestratorSessionResult;
    return { sessionId: body.sessionId, resumeToken: body.resumeToken };
  }

  /** Never throws -- an ordinary invalid/expired/mismatched resume (including a
   * network-level fetch failure) resolves null exactly like a non-2xx response does, so
   * ConnectionRelay.start() can unconditionally fall back to createSession() without a
   * try/catch of its own. Deliberately MORE defensive here than createSession()'s fetch
   * call (which can still throw on a network error) -- resume's whole purpose is "never
   * fail the call," so its failure path has to be airtight even though createSession()'s
   * pre-existing gap there is out of scope for this change. */
  async resumeSession(sessionId: string, resumeToken: string, userId: string): Promise<OrchestratorSessionResult | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeToken, userId }),
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
}
