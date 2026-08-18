import type { ToolSchema } from './brain/types.js';

/**
 * Session-level slot tracking -- a deterministic safety net across a multi-turn
 * conversation (e.g. a booking spread over several utterances), sitting alongside (never
 * instead of) the LLM's own function-calling. The LLM always drives WHAT gets called and
 * with what values; these helpers only backfill a value the LLM omitted/left blank from
 * something already established earlier in the SAME session, and validate that a tool
 * call isn't dispatched while still missing a value nothing in this session has ever
 * supplied -- protecting against a small model (llama-3.1-8b-instant, see
 * pipeline.ts's modelForRole()) mistyping or hallucinating a value it should just be
 * copying forward, not letting it skip supplying arguments in the first place.
 *
 * Only ever driven by TOOL CALL ARGUMENTS, never tool call RESULTS -- e.g. a doctor's
 * resolved name from find_doctors's response is never captured as a slot. This keeps the
 * merge logic generic/tool-agnostic instead of needing per-tool result-shape parsing, at
 * the cost that a value like doctorId only gets backfill protection starting from its
 * SECOND use in a session (the first mention still relies on the LLM correctly copying it
 * out of a prior tool result in history).
 */
export const BOOKING_SLOT_KEYS = ['doctorId', 'patientName', 'patientMobile', 'preferredDate', 'preferredTime', 'reason'];

function schemaProps(schema: ToolSchema): { properties: string[]; required: string[] } {
  const params = schema.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
  return { properties: Object.keys(params.properties ?? {}), required: params.required ?? [] };
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Fills any of `toolName`'s known parameters that are missing/empty in `args` from
 * `slots` (a value already collected earlier in the session, e.g. a doctorId found via
 * find_doctors two turns ago). Returns a new object -- `args`/`slots` are untouched. */
export function backfillArgsFromSlots(
  toolName: string,
  args: Record<string, unknown>,
  slots: Record<string, unknown>,
  schemas: ToolSchema[],
): Record<string, unknown> {
  const schema = schemas.find((s) => s.function.name === toolName);
  if (!schema) return args;
  const { properties } = schemaProps(schema);
  const filled = { ...args };
  for (const key of properties) {
    if (isEmpty(filled[key]) && !isEmpty(slots[key])) filled[key] = slots[key];
  }
  return filled;
}

/** `toolName`'s still-missing required parameters -- call AFTER backfillArgsFromSlots, so
 * this only flags a value nothing in the session (neither this call nor an earlier one)
 * has ever supplied. */
export function missingRequiredArgs(toolName: string, args: Record<string, unknown>, schemas: ToolSchema[]): string[] {
  const schema = schemas.find((s) => s.function.name === toolName);
  if (!schema) return [];
  const { required } = schemaProps(schema);
  return required.filter((key) => isEmpty(args[key]));
}

/** Merges a tool call's own (backfilled) arguments into the session's slot bag --
 * MUTATES `slots` in place (matching how `history` is mutated via .push() elsewhere in
 * this codebase). Last-write-wins per key, and only ever ADDS/overwrites with a
 * non-empty value -- an omitted or blank argument on a later call must never erase a
 * value collected earlier in the conversation. */
export function mergeSlots(slots: Record<string, unknown>, args: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(args)) {
    if (!isEmpty(value)) slots[key] = value;
  }
}

/** Clears booking-identity slots after a SUCCESSFUL book_appointment, so a second
 * patient's booking later in the same call never silently inherits the first patient's
 * name/mobile/date/doctor via backfill (mergeSlots is otherwise last-write-wins with no
 * expiry).
 *
 * Documented residual limitation: a doctor-pivot mid-flow (check availability for Dr. A,
 * decide on Dr. C instead, then a book_appointment call that omits doctorId) can still
 * backfill the wrong doctor until a booking actually completes -- accepted as a
 * lower-severity risk than cross-patient contact-info contamination, not solved here
 * (would need real intent-tracking, out of scope for an LLM-reliability safety net). */
export function clearBookingSlots(slots: Record<string, unknown>): void {
  for (const key of BOOKING_SLOT_KEYS) delete slots[key];
}

/** Keys in `after` whose value differs from `before[key]` -- used so a UI_FORM_AUTOFILL
 * push only carries what's new THIS turn, not the whole accumulated slot bag every time.
 * `before` defaults to `{}` so a pre-this-feature session with `slots === undefined`
 * doesn't throw (SessionStore's 30-minute TTL means this window is narrow, but the guard
 * is free). */
export function diffSlots(before: Record<string, unknown> = {}, after: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) changed[key] = value;
  }
  return changed;
}
