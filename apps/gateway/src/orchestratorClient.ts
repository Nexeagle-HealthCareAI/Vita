export interface CreateSessionInput {
  sessionId: string;
  userId: string;
  role: 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';
}

export interface TurnAudioResult {
  transcript: string; // '' on soft no-op (VAD armed an utterance but STT heard no words)
  replyText: string | null; // null iff transcript === ''
  audioBase64: string | null; // null iff transcript === ''
  toolCallsExecuted: string[];
}

export interface RelayError {
  code: string;
  message: string;
  recoverable: boolean;
}

export type TurnAudioResponse = { ok: true; data: TurnAudioResult } | { ok: false; error: RelayError };

// Same constructor-injected-fetch pattern as HmsClient/GroqClient/SarvamClient in
// apps/orchestrator -- lets tests mock this without a real HTTP call.
export class OrchestratorClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string } | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sessionId: string };
    return { sessionId: body.sessionId };
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
