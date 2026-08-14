import { describe, expect, it } from 'vitest';
import { frameify, loadFixtureWav, parseWav, FRAME_SAMPLES, SAMPLE_RATE } from '../src/fixtures.js';

/** Builds a minimal canonical 16-bit PCM WAV buffer -- mirrors exactly what Python's
 * stdlib `wave` module (used by mix_snr.py) writes, so this test doesn't depend on any
 * external WAV-writing library. */
function buildWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const dataBytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes.length, 40);
  return Buffer.concat([header, dataBytes]);
}

describe('parseWav', () => {
  it('parses a canonical 16-bit PCM WAV back to its exact samples', () => {
    const samples = new Int16Array([0, 100, -100, 32767, -32768]);
    const buffer = buildWav(samples);

    const wav = parseWav(buffer);

    expect(wav.sampleRate).toBe(SAMPLE_RATE);
    expect(wav.channels).toBe(1);
    expect(wav.bitsPerSample).toBe(16);
    expect(Array.from(wav.samples)).toEqual(Array.from(samples));
  });

  it('rejects a non-RIFF buffer', () => {
    expect(() => parseWav(Buffer.from('not a wav file at all'))).toThrow(/RIFF/);
  });
});

describe('frameify', () => {
  it('splits into 320-sample frames and drops a short trailing partial frame', () => {
    const samples = new Int16Array(750); // 2 full 320-sample frames + a 110-sample remainder
    samples.fill(1);

    const frames = frameify(samples);

    expect(frames.length).toBe(2);
    expect(frames[0].byteLength).toBe(FRAME_SAMPLES * 2); // 2 bytes/sample
  });

  it('frame bytes decode back to the correct samples in order', () => {
    const samples = new Int16Array(FRAME_SAMPLES * 2);
    for (let i = 0; i < samples.length; i++) samples[i] = i;

    const [firstFrame, secondFrame] = frameify(samples);

    const decoded1 = new Int16Array(firstFrame.buffer, firstFrame.byteOffset, FRAME_SAMPLES);
    const decoded2 = new Int16Array(secondFrame.buffer, secondFrame.byteOffset, FRAME_SAMPLES);
    expect(decoded1[0]).toBe(0);
    expect(decoded1[FRAME_SAMPLES - 1]).toBe(FRAME_SAMPLES - 1);
    expect(decoded2[0]).toBe(FRAME_SAMPLES);
  });
});

describe('loadFixtureWav (against the real Half-1 fixtures)', () => {
  it('loads a real committed fixture and frames it', () => {
    const wav = loadFixtureWav('book-appointment-clean.wav');

    expect(wav.sampleRate).toBe(SAMPLE_RATE);
    expect(wav.samples.length).toBeGreaterThan(SAMPLE_RATE); // more than 1s of audio

    const frames = frameify(wav.samples);
    expect(frames.length).toBeGreaterThan(50); // a few seconds of 20ms frames
  });
});
