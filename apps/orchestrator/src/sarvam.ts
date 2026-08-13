/**
 * Thin typed client over Sarvam AI's speech APIs. Same injected-fetch pattern as
 * packages/mcp-1hms/src/hmsClient.ts and groq.ts, for the same reason: unit-testable
 * without real network access.
 *
 * SCOPE NOTE: both methods are batch calls (one full utterance / one full reply in,
 * one result out), not the true low-latency streaming SARVAM_STT_ENDPOINT's name implies
 * ("speech-to-text-streaming"). transcribe() is called once per already-VAD-segmented
 * utterance from the caller, not fed audio incrementally — real streaming (partial
 * transcripts as the user is still talking) is follow-up work once the gateway's audio
 * relay exists to actually feed this in real time.
 *
 * HONESTY NOTE: the exact request/response field names below are my best understanding
 * of Sarvam's API, not verified against current live docs. Both methods are narrow and
 * self-contained specifically so fixing a field name mismatch (once tested against a
 * real key) is a one-file change that doesn't ripple into pipeline.ts.
 */

export interface TranscribeResult {
  text: string;
}

const DEFAULT_LANGUAGE_CODE = 'en-IN';

export class SarvamClient {
  constructor(
    private apiKey: string,
    private sttEndpoint: string,
    private ttsEndpoint: string,
    private fetchImpl: typeof fetch = fetch,
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
    });

    if (!res.ok) {
      throw new Error(`Sarvam STT failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { transcript: string };
    return { text: data.transcript };
  }

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
