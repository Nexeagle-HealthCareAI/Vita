import { describe, expect, it } from 'vitest';
import { backfillArgsFromSlots, missingRequiredArgs, mergeSlots, clearBookingSlots, diffSlots } from '../src/slots.js';
import { TOOL_SCHEMAS } from '../src/tools.js';

describe('backfillArgsFromSlots', () => {
  it('fills a missing argument from a previously-collected slot', () => {
    const filled = backfillArgsFromSlots('book_appointment', { patientName: 'Riya' }, { patientMobile: '9999999999' }, TOOL_SCHEMAS);
    expect(filled).toEqual({ patientName: 'Riya', patientMobile: '9999999999' });
  });

  it('never overwrites an argument the call itself already supplied', () => {
    const filled = backfillArgsFromSlots('book_appointment', { patientMobile: '1111111111' }, { patientMobile: '9999999999' }, TOOL_SCHEMAS);
    expect(filled.patientMobile).toBe('1111111111');
  });

  it('treats an empty string the same as missing', () => {
    const filled = backfillArgsFromSlots('book_appointment', { patientMobile: '' }, { patientMobile: '9999999999' }, TOOL_SCHEMAS);
    expect(filled.patientMobile).toBe('9999999999');
  });

  it('does not mutate the input args or slots objects', () => {
    const args = { patientName: 'Riya' };
    const slots = { patientMobile: '9999999999' };
    backfillArgsFromSlots('book_appointment', args, slots, TOOL_SCHEMAS);
    expect(args).toEqual({ patientName: 'Riya' });
    expect(slots).toEqual({ patientMobile: '9999999999' });
  });

  it('backfills check_doctor_availability.preferredDate from a doctorId+preferredDate slot set while booking earlier -- the cross-tool naming fix', () => {
    const filled = backfillArgsFromSlots('check_doctor_availability', { doctorId: 'd-1' }, { preferredDate: '2026-08-20' }, TOOL_SCHEMAS);
    expect(filled).toEqual({ doctorId: 'd-1', preferredDate: '2026-08-20' });
  });

  it('ignores an unknown tool name', () => {
    const filled = backfillArgsFromSlots('not_a_real_tool', { a: 1 }, { b: 2 }, TOOL_SCHEMAS);
    expect(filled).toEqual({ a: 1 });
  });
});

describe('missingRequiredArgs', () => {
  it('lists required fields still empty after backfill', () => {
    const missing = missingRequiredArgs('book_appointment', { doctorId: 'd-1', patientName: 'Riya' }, TOOL_SCHEMAS);
    expect(missing).toEqual(['patientMobile', 'preferredDate']);
  });

  it('returns an empty array once every required field is present', () => {
    const missing = missingRequiredArgs(
      'book_appointment',
      { doctorId: 'd-1', patientName: 'Riya', patientMobile: '9999999999', preferredDate: '2026-08-20' },
      TOOL_SCHEMAS,
    );
    expect(missing).toEqual([]);
  });

  it('find_doctors has no required fields', () => {
    expect(missingRequiredArgs('find_doctors', {}, TOOL_SCHEMAS)).toEqual([]);
  });
});

describe('mergeSlots', () => {
  it('adds new keys and mutates the slots object in place', () => {
    const slots: Record<string, unknown> = {};
    mergeSlots(slots, { patientName: 'Riya', patientMobile: '9999999999' });
    expect(slots).toEqual({ patientName: 'Riya', patientMobile: '9999999999' });
  });

  it('last-write-wins for a repeated key', () => {
    const slots: Record<string, unknown> = { patientName: 'Riya' };
    mergeSlots(slots, { patientName: 'Asha' });
    expect(slots.patientName).toBe('Asha');
  });

  it('never erases an existing value with an empty/missing one', () => {
    const slots: Record<string, unknown> = { patientMobile: '9999999999' };
    mergeSlots(slots, { patientMobile: '', patientName: undefined });
    expect(slots).toEqual({ patientMobile: '9999999999' });
  });
});

describe('clearBookingSlots', () => {
  it('deletes only booking-scoped keys after a successful booking, leaving unrelated slots intact', () => {
    const slots: Record<string, unknown> = {
      doctorId: 'd-1',
      patientName: 'Riya',
      patientMobile: '9999999999',
      preferredDate: '2026-08-20',
      preferredTime: '10:00',
      reason: 'follow-up',
      city: 'Pune',
    };
    clearBookingSlots(slots);
    expect(slots).toEqual({ city: 'Pune' });
  });

  it('prevents a second patient in the same session from inheriting the first patient\'s contact info', () => {
    const slots: Record<string, unknown> = {};
    mergeSlots(slots, { doctorId: 'd-1', patientName: 'Riya', patientMobile: '9999999999', preferredDate: '2026-08-20' });
    clearBookingSlots(slots);
    const filledForPatientB = backfillArgsFromSlots('book_appointment', { patientName: 'Asha', preferredDate: '2026-08-21' }, slots, TOOL_SCHEMAS);
    expect(filledForPatientB.patientMobile).toBeUndefined();
  });
});

describe('diffSlots', () => {
  it('returns only keys whose value changed', () => {
    const diff = diffSlots({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(diff).toEqual({ b: 3, c: 4 });
  });

  it('returns an empty object when nothing changed', () => {
    expect(diffSlots({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('defaults `before` to {} so an undefined prior slots bag does not throw', () => {
    expect(diffSlots(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});
