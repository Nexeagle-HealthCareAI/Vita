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
    // Real per-frame model inference (denoise + VAD) on a call this relay is actively
    // relaying LIVE audio for -- this previously had no bound at all. A hung/slow
    // audio-preprocess instance (or one saturated past its real capacity, see
    // tools/load-test's own findings on this exact service) would silently freeze every
    // call routed through it indefinitely: no ERROR to the client, no timeout, and no
    // health check able to detect it (a plain instance-level fetch failure/hang here
    // never reaches either service's own /healthz). Default generous versus this
    // service's normal per-frame latency, but still well inside a live caller's patience
    // for one 20ms frame.
    private timeoutMs = Number(process.env.AUDIO_PREPROCESS_TIMEOUT_MS ?? 2000),
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
      signal: AbortSignal.timeout(this.timeoutMs),
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
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`audio-preprocess teardown failed: ${res.status}`);
    }
  }
}
