import { z } from 'zod';

/**
 * PROTOCOL_VERSION bumps whenever an event shape changes in a
 * backward-incompatible way. Gateway and orchestrator reject any
 * client whose `hello.version` is behind the minimum supported version.
 * This is what makes the Phase 2 mobile SDK's "zero backend changes"
 * claim actually true — mobile just has to speak the same versioned
 * contract, not something inferred from the web client's code.
 */
export const PROTOCOL_VERSION = 1;

// ---- Control-plane events (JSON) ----

export const HelloEvent = z.object({
  event: z.literal('HELLO'),
  version: z.literal(PROTOCOL_VERSION),
  role: z.enum(['ROLE_RECEPTIONIST', 'ROLE_DOCTOR']).optional(), // advisory only; server derives real role from JWT
});

export const StateChangeEvent = z.object({
  event: z.literal('STATE_CHANGE'),
  state: z.enum(['IDLE', 'LISTENING', 'PROCESSING', 'SPEAKING', 'ERROR']),
});

export const TranscriptEvent = z.object({
  event: z.literal('TRANSCRIPT'),
  text: z.string(),
  is_final: z.boolean(),
});

export const FormAutofillEvent = z.object({
  event: z.literal('UI_FORM_AUTOFILL'),
  data: z.record(z.string(), z.unknown()),
});

/** [NEW] Server tells the client to immediately flush its playback buffer — barge-in. */
export const ClearPlaybackEvent = z.object({
  event: z.literal('CLEAR_PLAYBACK'),
  reason: z.enum(['USER_BARGE_IN', 'SESSION_RESET']),
});

export const ErrorEvent = z.object({
  event: z.literal('ERROR'),
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

export const ServerControlEvent = z.discriminatedUnion('event', [
  StateChangeEvent,
  TranscriptEvent,
  FormAutofillEvent,
  ClearPlaybackEvent,
  ErrorEvent,
]);
export type ServerControlEvent = z.infer<typeof ServerControlEvent>;

export const ClientControlEvent = HelloEvent;
export type ClientControlEvent = z.infer<typeof ClientControlEvent>;

// ---- Data-plane frames (binary, NOT JSON) ----
// Wire format: 1-byte frame type prefix + raw payload bytes.
// This replaces the old JSON+base64 AUDIO_FRAME / AUDIO_OUTPUT_CHUNK events,
// which cost ~33% bandwidth/CPU overhead for no benefit on a hot audio path.
export const BinaryFrameType = {
  AUDIO_INPUT_PCM16: 0x01, // client -> server, 16kHz mono PCM16 chunk
  AUDIO_OUTPUT_PCM16: 0x02, // server -> client, TTS audio chunk
} as const;
export type BinaryFrameTypeValue = (typeof BinaryFrameType)[keyof typeof BinaryFrameType];

export function encodeBinaryFrame(type: BinaryFrameTypeValue, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export function decodeBinaryFrame(frame: Uint8Array): {
  type: BinaryFrameTypeValue;
  payload: Uint8Array;
} {
  return { type: frame[0] as BinaryFrameTypeValue, payload: frame.subarray(1) };
}
