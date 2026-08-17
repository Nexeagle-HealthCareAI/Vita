/**
 * Vendor-agnostic STT layer. pipeline.ts/index.ts/streamSession.ts depend on these
 * interfaces, not on "Sarvam" directly, so a different STT vendor could be swapped in
 * later without touching business logic. sarvam.ts's SarvamSttProvider (batch) and
 * sarvamRealtime.ts's SarvamRealtimeSttSession (streaming) are the only implementations
 * today.
 */

export interface TranscribeResult {
  text: string;
}

/** One-shot batch STT: a full utterance in, one transcript out. */
export interface SttProvider {
  transcribe(audioPcm16: Uint8Array, languageCode?: string): Promise<TranscribeResult>;
}

/** Real-time streaming STT: a stateful, session-scoped connection fed audio
 * incrementally, yielding partial/final transcripts via callbacks instead of a single
 * return value. Deliberately NOT unified with SttProvider -- batch and streaming STT are
 * different interaction models, not just different vendors. */
export interface StreamingSttSession {
  onPartialTranscript(cb: (text: string) => void): void;
  onFinalTranscript(cb: (text: string) => void): void;
  /** is_fatal, or a close/error before the session was ever ready, or an unexpected
   * close/error after it was -- see implementations for exact semantics. */
  onFatal(cb: (reason: string) => void): void;
  connect(timeoutMs: number): Promise<void>;
  sendAudio(frame: Uint8Array): void;
  sendSpeechStart(): void;
  sendSpeechEnd(): void;
  end(): void;
}
