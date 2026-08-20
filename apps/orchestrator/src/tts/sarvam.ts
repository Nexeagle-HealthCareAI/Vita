import type { TtsProvider } from './types.js';

/**
 * Thin typed client over Sarvam AI's text-to-speech API. Same injected-fetch pattern as
 * stt/sarvam.ts's SarvamSttProvider -- see that file's doc comment for the shared
 * reasoning (unit-testable without real network access, narrow/self-contained so a field
 * name fix stays a one-file change).
 *
 * HONESTY NOTE: the exact request/response field names below are my best understanding
 * of Sarvam's API, not verified against current live docs.
 */
const DEFAULT_LANGUAGE_CODE = 'en-IN';

export class SarvamTtsProvider implements TtsProvider {
  constructor(
    private apiKey: string,
    private ttsEndpoint: string,
    private fetchImpl: typeof fetch = fetch,
    // Bounds one synthesis call (pipeline.ts calls this once per sentence on the
    // streaming path) -- previously unbounded, so a hung/slow Sarvam connection could
    // freeze a live call indefinitely. A single sentence should synthesize quickly; this
    // stays generous versus that normal latency while still being bounded.
    private timeoutMs = Number(process.env.SARVAM_TTS_REQUEST_TIMEOUT_MS ?? 8_000),
  ) {}

  async synthesize(text: string, languageCode: string = DEFAULT_LANGUAGE_CODE): Promise<Uint8Array> {
    const res = await this.fetchImpl(this.ttsEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-Subscription-Key': this.apiKey,
      },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: languageCode,
        model: 'bulbul:v1',
        // 16kHz mono PCM16, matching the protocol's AUDIO_OUTPUT_PCM16 wire format
        // (packages/protocol/src/events.ts) -- adjust if Sarvam's actual output format
        // param name/values differ.
        speech_sample_rate: 16000,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Sarvam TTS failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { audios: string[] };
    const base64Audio = data.audios[0];
    if (!base64Audio) {
      throw new Error('Sarvam TTS returned no audio');
    }
    return Uint8Array.from(Buffer.from(base64Audio, 'base64'));
  }
}
