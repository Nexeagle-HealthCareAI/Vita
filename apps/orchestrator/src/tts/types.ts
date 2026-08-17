/**
 * Vendor-agnostic TTS layer. See stt/types.ts's doc comment -- same reasoning, same
 * intent. sarvam.ts's SarvamTtsProvider is the only implementation today.
 */
export interface TtsProvider {
  synthesize(text: string, languageCode?: string): Promise<Uint8Array>;
}
