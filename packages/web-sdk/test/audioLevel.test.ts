import { describe, expect, it } from 'vitest';
import { computeRmsLevel } from '../src/audioLevel.js';

describe('computeRmsLevel', () => {
  it('returns 0 for silence (an all-zero frame)', () => {
    expect(computeRmsLevel(new Int16Array(320))).toBe(0);
  });

  it('returns 0 for an empty frame -- no division-by-zero/NaN', () => {
    expect(computeRmsLevel(new Int16Array(0))).toBe(0);
  });

  it('returns exactly the constant amplitude for a frame of identical samples', () => {
    // Every sample at half-scale (16384 / 32768 = 0.5) -- RMS of a constant signal
    // equals its own magnitude.
    const frame = new Int16Array(320).fill(16384);
    expect(computeRmsLevel(frame)).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.707 for a full-scale sine wave (the standard RMS-of-a-sine-wave result)', () => {
    const frame = new Int16Array(320);
    for (let i = 0; i < frame.length; i++) {
      frame[i] = Math.round(32767 * Math.sin((2 * Math.PI * 5 * i) / frame.length));
    }
    expect(computeRmsLevel(frame)).toBeCloseTo(0.707, 2);
  });

  it('a quiet frame produces a proportionally low level, not zero', () => {
    const frame = new Int16Array(320).fill(328); // ~1% of full scale
    const level = computeRmsLevel(frame);
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThan(0.02);
  });
});
