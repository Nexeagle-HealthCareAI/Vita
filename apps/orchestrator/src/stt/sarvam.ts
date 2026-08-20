import type { SttProvider, TranscribeResult } from './types.js';

/**
 * Thin typed client over Sarvam AI's batch speech-to-text API. Same injected-fetch
 * pattern as packages/mcp-1hms/src/hmsClient.ts and brain/groq.ts, for the same reason:
 * unit-testable without real network access.
 *
 * SCOPE NOTE: this is a batch call (one full utterance in, one result out), not the true
 * low-latency streaming SARVAM_STT_ENDPOINT's name implies ("speech-to-text-streaming").
 * transcribe() is called once per already-VAD-segmented utterance from the caller, not
 * fed audio incrementally -- real-time streaming STT is sarvamRealtime.ts's
 * SarvamRealtimeSttSession, a structurally different (session/callback-based, not
 * one-shot) interaction model, see stt/types.ts's StreamingSttSession.
 *
 * HONESTY NOTE: the exact request/response field names below are my best understanding
 * of Sarvam's API, not verified against current live docs. This class is narrow and
 * self-contained specifically so fixing a field name mismatch (once tested against a
 * real key) is a one-file change that doesn't ripple into pipeline.ts.
 */
const DEFAULT_LANGUAGE_CODE = 'en-IN';

export class SarvamSttProvider implements SttProvider {
  constructor(
    private apiKey: string,
    private sttEndpoint: string,
    private fetchImpl: typeof fetch = fetch,
    // Bounds one batch transcription call -- previously unbounded, so a hung/slow Sarvam
    // connection could freeze a live call indefinitely. Generous versus a real call's
    // normal latency (transcribing up to a ~20s utterance), still bounded overall.
    private timeoutMs = Number(process.env.SARVAM_STT_REQUEST_TIMEOUT_MS ?? 10_000),
  ) {}

  async transcribe(audioPcm16: Uint8Array, languageCode: string = DEFAULT_LANGUAGE_CODE): Promise<TranscribeResult> {
    const form = new FormData();
    // Sarvam's REST STT endpoints take a multipart file field named "file" (WAV/PCM),
    // plus a language_code field -- adjust here if the real API expects a different
    // field name or a WAV container instead of raw PCM16 bytes.
    form.append('file', new Blob([audioPcm16 as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('language_code', languageCode);
    form.append('model', 'saarika:v2');

    const res = await this.fetchImpl(this.sttEndpoint, {
      method: 'POST',
      headers: { 'API-Subscription-Key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Sarvam STT failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { transcript: string };
    return { text: data.transcript };
  }
}
