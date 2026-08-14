import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url)); // tools/load-test/src

/** Reuses apps/audio-preprocess's real-audio fixtures directly (single source of truth,
 * no duplication) -- the same TTS-synthesized WAVs tests/test_real_audio_fixtures.py
 * validates VAD/denoise accuracy against. */
const FIXTURES_DIR = path.resolve(THIS_DIR, '../../../apps/audio-preprocess/tests/fixtures');

export const FRAME_SAMPLES = 320; // 20ms @ 16kHz, this system's native frame size
export const SAMPLE_RATE = 16000;

export interface WavAudio {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: Int16Array;
}

/** Minimal canonical-PCM-WAV reader (RIFF/WAVE, one 'fmt ' chunk, one 'data' chunk) --
 * matches exactly what Python's stdlib `wave` module (used by
 * apps/audio-preprocess/tests/fixtures/mix_snr.py) writes. Not a general-purpose WAV
 * parser -- doesn't handle extended fmt chunks, extra metadata chunks, or compressed
 * formats, none of which this repo's fixtures ever use.
 */
export function parseWav(buffer: Buffer): WavAudio {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: Buffer | undefined;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(chunkStart, chunkStart + chunkSize);
    }

    offset = chunkStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (!fmt || !data) throw new Error('WAV file missing fmt or data chunk');
  if (fmt.bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${fmt.bitsPerSample}-bit`);

  const samples = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, samples };
}

export function loadFixtureWav(fileName: string): WavAudio {
  const buffer = readFileSync(path.join(FIXTURES_DIR, fileName));
  const wav = parseWav(buffer);
  if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1) {
    throw new Error(`${fileName}: expected ${SAMPLE_RATE}Hz mono, got ${wav.sampleRate}Hz/${wav.channels}ch`);
  }
  return wav;
}

/** Splits into this system's native 20ms/320-sample frames as raw little-endian PCM16
 * bytes, ready for encodeBinaryFrame(AUDIO_INPUT_PCM16, ...). Drops a short trailing
 * partial frame -- real callers' utterances aren't frame-aligned either, and the real
 * pipeline has no special handling for one beyond just not sending it. */
export function frameify(samples: Int16Array, frameSamples: number = FRAME_SAMPLES): Uint8Array[] {
  const frameCount = Math.floor(samples.length / frameSamples);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = samples.subarray(i * frameSamples, (i + 1) * frameSamples);
    frames.push(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
  }
  return frames;
}
