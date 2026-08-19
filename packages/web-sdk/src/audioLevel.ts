/**
 * A simple amplitude meter for local UI feedback (e.g. a bouncing mic-level indicator)
 * -- NOT phonetic/neural VAD, and NOT a turn-taking signal. Server-side Silero VAD
 * (apps/audio-preprocess) remains the sole authority for turn-taking/barge-in; this
 * value is computed and consumed entirely client-side (see index.ts's onAudioLevel)
 * and never reaches the server.
 */

/** RMS (root-mean-square) amplitude of a PCM16 frame, roughly 0-1 (a full-scale int16
 * sine wave's RMS is ~0.707). Returns the raw, unscaled value -- a host app applies its
 * own visual gain/compression curve rather than this SDK guessing one that suits every
 * UI. */
export function computeRmsLevel(pcm16: Int16Array): number {
  if (pcm16.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < pcm16.length; i++) {
    const normalized = pcm16[i]! / 0x8000; // back to a [-1, 1) float range
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / pcm16.length);
}
