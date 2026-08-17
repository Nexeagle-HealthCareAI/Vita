import { describe, expect, it } from 'vitest';
import {
  BinaryFrameType,
  ServerControlEvent,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from '../src/events.js';

describe('binary frame codec', () => {
  it('round-trips a PCM16 audio chunk', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeBinaryFrame(BinaryFrameType.AUDIO_INPUT_PCM16, payload);
    const { type, payload: decoded } = decodeBinaryFrame(frame);
    expect(type).toBe(BinaryFrameType.AUDIO_INPUT_PCM16);
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });
});

describe('server control event schema', () => {
  it('accepts a valid TRANSCRIPT event', () => {
    const parsed = ServerControlEvent.safeParse({
      event: 'TRANSCRIPT',
      text: 'patient wants a cardiology slot',
      is_final: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid REPLY_TEXT event with no final field (backward compatible)', () => {
    const parsed = ServerControlEvent.safeParse({ event: 'REPLY_TEXT', text: 'Dr. Patel is in from 9 to 1.' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a REPLY_TEXT event with final:false (a non-last sentence chunk)', () => {
    const parsed = ServerControlEvent.safeParse({ event: 'REPLY_TEXT', text: 'Dr. Patel is in from 9 to 1.', final: false });
    expect(parsed.success).toBe(true);
  });

  it('accepts a REPLY_TEXT event with final:true (the last chunk of a turn)', () => {
    const parsed = ServerControlEvent.safeParse({ event: 'REPLY_TEXT', text: 'Anything else?', final: true });
    expect(parsed.success).toBe(true);
  });

  it('rejects a REPLY_TEXT event missing text', () => {
    expect(ServerControlEvent.safeParse({ event: 'REPLY_TEXT' }).success).toBe(false);
  });

  it('accepts a CLEAR_PLAYBACK barge-in event', () => {
    const parsed = ServerControlEvent.safeParse({
      event: 'CLEAR_PLAYBACK',
      reason: 'USER_BARGE_IN',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown event name', () => {
    const parsed = ServerControlEvent.safeParse({ event: 'NOT_A_REAL_EVENT' });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid SESSION_READY event, both resumed:true and resumed:false', () => {
    expect(
      ServerControlEvent.safeParse({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1', resumed: false }).success,
    ).toBe(true);
    expect(
      ServerControlEvent.safeParse({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-2', resumed: true }).success,
    ).toBe(true);
  });

  it('rejects a SESSION_READY event missing resumeToken or resumed', () => {
    expect(ServerControlEvent.safeParse({ event: 'SESSION_READY', sessionId: 'sess-1', resumed: false }).success).toBe(false);
    expect(ServerControlEvent.safeParse({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1' }).success).toBe(false);
  });
});
