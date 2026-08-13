export interface PreprocessResult {
  frame: Uint8Array; // denoised frame, same length as input (pass-through today -- see apps/audio-preprocess)
  speechDetected: boolean;
}

// Same constructor-injected-fetch pattern as HmsClient/GroqClient/SarvamClient in
// apps/orchestrator -- lets tests mock this without a real HTTP call.
export class AudioPreprocessClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async process(frame: Uint8Array): Promise<PreprocessResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/process`, {
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
}
