export interface PreprocessResult {
  frame: Uint8Array; // denoised frame, same length as input (real DeepFilterNet output once loaded -- see apps/audio-preprocess)
  speechDetected: boolean;
}

// Same constructor-injected-fetch pattern as HmsClient/GroqClient/SarvamClient in
// apps/orchestrator -- lets tests mock this without a real HTTP call.
export class AudioPreprocessClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  // Session-scoped so audio-preprocess's real streaming models (Silero VAD,
  // DeepFilterNet) can keep state across the frames of one call instead of treating
  // each one independently -- see apps/audio-preprocess/app/session_registry.py.
  async process(frame: Uint8Array, sessionId: string): Promise<PreprocessResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // TS's DOM-lib BodyInit doesn't structurally match Uint8Array's ArrayBufferLike
      // generic in this TS/lib combo -- same friction apps/orchestrator/src/sarvam.ts
      // already works around; Node's fetch accepts a Uint8Array body fine at runtime.
      body: frame as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`audio-preprocess failed: ${res.status}`);
    }
    return {
      frame: new Uint8Array(await res.arrayBuffer()),
      speechDetected: res.headers.get('x-tera-speech-detected') === '1',
    };
  }

  // Explicit end-of-call teardown so audio-preprocess can free that session's model
  // state promptly instead of waiting out its TTL safety net. Fire-and-forget from the
  // caller's side (see relay.ts's close()), matching relay.start()'s existing pattern.
  async teardown(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error(`audio-preprocess teardown failed: ${res.status}`);
    }
  }
}
