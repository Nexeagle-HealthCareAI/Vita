import { describe, expect, it } from 'vitest';
import { normalizePhonetics } from '../src/phoneticNormalizer.js';

describe('normalizePhonetics', () => {
  it('expands "Dr." to "Doctor"', () => {
    expect(normalizePhonetics('Dr. Patel is in today.')).toBe('Doctor Patel is in today.');
  });

  it('expands "Mrs." to "Missus"', () => {
    expect(normalizePhonetics('Mrs. Rao called earlier.')).toBe('Missus Rao called earlier.');
  });

  it('expands "Mr." to "Mister" without being confused by the "Mrs." branch', () => {
    expect(normalizePhonetics('Mr. Singh is next.')).toBe('Mister Singh is next.');
  });

  it('expands "Ms." to "Miss"', () => {
    expect(normalizePhonetics('Ms. Iyer will call back.')).toBe('Miss Iyer will call back.');
  });

  it('converts a 24-hour HH:MM:SS time to spoken 12-hour form, dropping seconds', () => {
    expect(normalizePhonetics('The shift ends at 14:30:00.')).toBe('The shift ends at 2:30 PM.');
  });

  it('converts a 24-hour HH:MM time (single-digit hour with leading zero)', () => {
    expect(normalizePhonetics('Available from 09:05.')).toBe('Available from 9:05 AM.');
  });

  it('midnight (00:00) reads as 12:00 AM', () => {
    expect(normalizePhonetics('Closes at 00:00.')).toBe('Closes at 12:00 AM.');
  });

  it('noon (12:00) reads as 12:00 PM', () => {
    expect(normalizePhonetics('Lunch break at 12:00.')).toBe('Lunch break at 12:00 PM.');
  });

  it('leaves an already-natural 12-hour time untouched instead of double-converting it', () => {
    expect(normalizePhonetics('The appointment is at 2:30 PM.')).toBe('The appointment is at 2:30 PM.');
    expect(normalizePhonetics('See you at 9:00 am.')).toBe('See you at 9:00 am.');
  });

  it('converts a YYYY-MM-DD date to a spoken month/day/year form', () => {
    expect(normalizePhonetics('Booked for 2026-08-20.')).toBe('Booked for August 20, 2026.');
  });

  it('leaves an out-of-range month untouched rather than guessing', () => {
    expect(normalizePhonetics('Ref: 2026-13-20.')).toBe('Ref: 2026-13-20.');
  });

  it('handles multiple different patterns in the same string', () => {
    expect(normalizePhonetics('Dr. Patel is free on 2026-08-20 at 14:30:00.')).toBe(
      'Doctor Patel is free on August 20, 2026 at 2:30 PM.',
    );
  });

  it('leaves plain text with no matching patterns completely untouched', () => {
    const text = "Sure, I'll check that for you and get back to you shortly.";
    expect(normalizePhonetics(text)).toBe(text);
  });

  it('does not false-positive on a word that merely starts with a title-like prefix', () => {
    expect(normalizePhonetics('Drive safely and Mister Rogers says hello.')).toBe('Drive safely and Mister Rogers says hello.');
  });
});
