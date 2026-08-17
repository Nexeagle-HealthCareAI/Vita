import { describe, expect, it } from 'vitest';
import { splitCompletedSentences } from '../src/sentenceSplitter.js';

describe('splitCompletedSentences', () => {
  it('a buffer with no terminal punctuation is entirely remainder', () => {
    const { complete, remainder } = splitCompletedSentences('Sure, one moment');
    expect(complete).toEqual([]);
    expect(remainder).toBe('Sure, one moment');
  });

  it('one complete sentence followed by a trailing space is split off, keeping its own whitespace', () => {
    const { complete, remainder } = splitCompletedSentences('Dr. Patel is available. ');
    // "Dr." is a known abbreviation and must not be mistaken for a sentence boundary.
    expect(complete).toEqual(['Dr. Patel is available. ']);
    expect(remainder).toBe('');
  });

  it('multiple complete sentences in one buffer are all split off in order', () => {
    const { complete, remainder } = splitCompletedSentences('Sure, one moment. Let me check that. ');
    expect(complete).toEqual(['Sure, one moment. ', 'Let me check that. ']);
    expect(remainder).toBe('');
  });

  it('a trailing punctuation mark with no whitespace after it (buffer might still be growing) stays remainder', () => {
    // Guards against splitting a decimal mid-number if the next chunk continues it, e.g.
    // "The dose is 2." now, "5 mg" arriving next -- without confirmed whitespace after the
    // period, this must not be treated as a real sentence boundary yet.
    const { complete, remainder } = splitCompletedSentences('The dose is 2.');
    expect(complete).toEqual([]);
    expect(remainder).toBe('The dose is 2.');
  });

  it('a real sentence boundary followed by more content is still detected mid-buffer', () => {
    const { complete, remainder } = splitCompletedSentences('The dose is 2.5 mg. Take it twice daily');
    expect(complete).toEqual(['The dose is 2.5 mg. ']);
    expect(remainder).toBe('Take it twice daily');
  });

  it('question and exclamation marks are also treated as sentence boundaries', () => {
    const { complete, remainder } = splitCompletedSentences('Is Dr. Patel around? Great! Let me check.');
    expect(complete).toEqual(['Is Dr. Patel around? ', 'Great! ']);
    expect(remainder).toBe('Let me check.');
  });

  it('a lone abbreviation with nothing after it stays remainder, not a false sentence', () => {
    const { complete, remainder } = splitCompletedSentences('Please ask Dr.');
    expect(complete).toEqual([]);
    expect(remainder).toBe('Please ask Dr.');
  });

  it('an empty buffer returns no complete sentences and an empty remainder', () => {
    const { complete, remainder } = splitCompletedSentences('');
    expect(complete).toEqual([]);
    expect(remainder).toBe('');
  });

  it('concatenating complete + remainder always reconstructs the original buffer exactly', () => {
    const buffer = 'Dr. Patel is in from 9 to 1 that day. Would you like to book an appointment?';
    const { complete, remainder } = splitCompletedSentences(buffer);
    expect(complete.join('') + remainder).toBe(buffer);
  });
});
