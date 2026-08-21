import { z } from 'zod';

/**
 * PROTOCOL_VERSION bumps whenever an event shape changes in a
 * backward-incompatible way. The gateway (apps/gateway/src/relay.ts) rejects any
 * client whose `hello.version` doesn't match, behind PROTOCOL_VERSION_ENFORCEMENT_ENABLED
 * -- ships dark until validated, same rollout posture as STREAMING_STT_ENABLED. The
 * orchestrator never sees a raw client message at all (only the gateway terminates the
 * client WS; the orchestrator only talks to the gateway's own internal HTTP/WS clients),
 * so it plays no role in this check, despite an earlier version of this comment claiming
 * otherwise. This is what's meant to make the Phase 2 mobile SDK's "zero backend
 * changes" claim actually true — mobile just has to speak the same versioned contract,
 * not something inferred from the web client's code.
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

/** The assistant's reply text for a turn -- previously only ever synthesized to audio and
 * played, never handed to the host app as text. May now fire MULTIPLE times per turn (one
 * per sentence, as each is synthesized) instead of exactly once -- `final` distinguishes
 * "more of this reply is still coming" (false/omitted) from "this is the last piece"
 * (true). `final` is optional rather than required specifically because this is the first
 * field added to an ALREADY-SHIPPED event type here (every other addition in this file has
 * been a whole new event type), which is a cardinality change, not a purely additive one --
 * an optional field means an out-of-lockstep sender/receiver degrades gracefully (reads as
 * "one complete reply") instead of failing validation outright. Not bumping
 * PROTOCOL_VERSION for this: gateway/orchestrator/web-sdk are always deployed together
 * (see this file's header), and there's no live third-party consumer yet (the Phase 2
 * mobile SDK doesn't exist). Always sent alongside (not instead of) the AUDIO_OUTPUT_PCM16
 * binary frames, one pair per chunk. */
export const ReplyTextEvent = z.object({
  event: z.literal('REPLY_TEXT'),
  text: z.string(),
  final: z.boolean().optional(),
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

/** Sent once, immediately after a session is established -- fresh OR resumed. `resumed`
 * distinguishes the two; every connection (even a first-ever one) needs a sessionId +
 * resumeToken handed to it before it can ever resume later, so this fires unconditionally
 * rather than only on an actual resume. Purely additive -- doesn't require a
 * PROTOCOL_VERSION bump, since old clients silently ignore event types they don't
 * recognize (see web-sdk's handleMessage(), which has no default: case). */
export const SessionReadyEvent = z.object({
  event: z.literal('SESSION_READY'),
  sessionId: z.string(),
  resumeToken: z.string(),
  resumed: z.boolean(),
});

export const ServerControlEvent = z.discriminatedUnion('event', [
  StateChangeEvent,
  TranscriptEvent,
  ReplyTextEvent,
  FormAutofillEvent,
  ClearPlaybackEvent,
  ErrorEvent,
  SessionReadyEvent,
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
  // undefined for a zero-length frame -- honest about noUncheckedIndexedAccess's own
  // `frame[0]: number | undefined` rather than casting it away. Every real consumer
  // already only ever checks `type === BinaryFrameType.SOME_VALUE`, which is false (and
  // handled as "unrecognized frame", the existing behavior) for undefined exactly the
  // same as for any other value that isn't a real BinaryFrameTypeValue.
  type: BinaryFrameTypeValue | undefined;
  payload: Uint8Array;
} {
  return { type: frame[0] as BinaryFrameTypeValue | undefined, payload: frame.subarray(1) };
}
