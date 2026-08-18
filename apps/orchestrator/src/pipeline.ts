import type { HmsClient } from '@vita/mcp-1hms';
import type { HybridRetriever } from '@vita/rag';
import type { BrainProvider, ChatMessage, ToolCall } from './brain/types.js';
import type { TtsProvider } from './tts/types.js';
import { TOOL_SCHEMAS, executeTool, toolSchemasForRole, UnknownToolError } from './tools.js';
import { assertToolPermission, isToolAllowed, ForbiddenError, type Role } from './rbac.js';
import { recordAuditEvent } from './audit.js';
import type { DialogueSession } from './session.js';
import { splitCompletedSentences } from './sentenceSplitter.js';
import { backfillArgsFromSlots, missingRequiredArgs, mergeSlots, clearBookingSlots, diffSlots } from './slots.js';
import { normalizePhonetics } from './phoneticNormalizer.js';

const MAX_TOOL_ROUNDS = 3;

const SHARED_INTRO =
  'You are Vita, a voice assistant helping hospital front-desk staff and doctors. ' +
  'Be concise -- your replies are spoken aloud. Use find_doctors to locate a doctor by ' +
  'specialty/name/city, check_doctor_availability to see if they are working on a given ' +
  'date. ';

/** Only included for a role that's actually allowed to call book_appointment -- see
 * buildSystemPrompt. Keeps the prompt itself upfront-RBAC-scoped, matching the tool list
 * (toolSchemasForRole) sent alongside it: a role that can't book is never told it can. */
const BOOKING_FRAGMENT =
  'Use book_appointment to request an appointment (this also registers the patient -- ' +
  'there is no separate registration step). Bookings are non-binding requests; the exact ' +
  'time is confirmed by hospital staff afterward, so never tell a patient their time is ' +
  'final. ';

const SHARED_OUTRO =
  'Use search_vita_faq for generic questions about Vita itself (what it is, ' +
  'what it can do, where it runs, etc.) rather than the hospital tools above. Use ' +
  'search_hospital_reference for clinical-prep and hospital-policy questions (fasting ' +
  'rules, visiting hours, what to bring for admission, discharge process, ' +
  'insurance/billing basics). Always follow anything from search_hospital_reference with ' +
  'a brief spoken reminder to confirm exact details with hospital staff, since specifics ' +
  'can vary. Never invent patient, doctor, availability, or Vita-related information -- ' +
  "only state what a tool call actually returned. Never invent a value for a tool call's " +
  'argument either -- if you do not know a required value, ask the caller for it rather ' +
  'than guessing.';

/** Role-scoped system prompt -- upfront RBAC's other half (alongside toolSchemasForRole
 * in tools.ts). Called once per session (see runTurn below: only seeded on a brand-new
 * session, since session.role never changes for a session's lifetime). */
function buildSystemPrompt(role: Role): string {
  return SHARED_INTRO + (isToolAllowed('book_appointment', role) ? BOOKING_FRAGMENT : '') + SHARED_OUTRO;
}

function modelForRole(role: DialogueSession['role']): string {
  return role === 'ROLE_DOCTOR'
    ? (process.env.GROQ_MODEL_DOCTOR ?? 'llama-3.1-70b-versatile')
    : (process.env.GROQ_MODEL_ADMIN ?? 'llama-3.1-8b-instant');
}

export interface RunTurnResult {
  replyText: string;
  audio: Uint8Array;
  toolCallsExecuted: string[];
  /** Caller (the /session/:id/turn route) persists this via SessionStore.update --
   * pipeline.ts deliberately never touches Redis/SessionStore directly, so it stays
   * testable with a plain in-memory session object. */
  updatedHistory: ChatMessage[];
  /** Same persistence contract as updatedHistory above -- the caller persists this via
   * SessionStore.update({ slots: ... }). Seeded from session.slots, then backfilled/merged
   * across every tool call this turn (see slots.ts) -- this is what the NEXT turn's
   * backfill reads from, so it reflects clearBookingSlots's post-booking reset. */
  updatedSlots: Record<string, unknown>;
  /** What's new-or-changed THIS turn, for a UI_FORM_AUTOFILL push -- deliberately NOT the
   * same as diffSlots(session.slots, updatedSlots): a value that was set and then cleared
   * within the SAME turn (e.g. a receptionist stating a patient's full booking in one
   * breath, completing it immediately) would otherwise vanish from that diff entirely,
   * even though the UI should still show it once. Computed from a separate high-water-mark
   * accumulator that mirrors every slot merge but is never reset by clearBookingSlots --
   * see the `touchedSlots` local below. Callers still own the ROLE_RECEPTIONIST gate (see
   * index.ts's computeFormFields) -- this field is populated unconditionally regardless of
   * role. */
  formFieldsThisTurn: Record<string, unknown>;
  /** Streaming path only (see onReplyChunk below) -- set when a mid-turn TTS failure cut
   * the reply short. history/audio/replyText above still reflect exactly what was
   * actually said before the failure (never silently discarded), so the caller should
   * still persist them; this field is what tells it to also surface an error afterward. */
  error?: string;
}

const MAX_TOOL_ROUNDS_FALLBACK_MESSAGE = "Sorry, I'm having trouble completing that right now. Could you repeat what you need?";

/** Executes every tool call in `toolCalls` against `hms`/`faqRetriever`/
 * `hospitalReferenceRetriever`, RBAC-checked and audited, appending a role:'tool' history
 * entry per call -- shared by both the non-streaming and streaming paths below, which
 * otherwise differ significantly in how they get from history to a spoken reply.
 *
 * Also owns slot-tracking (see slots.ts): backfills a call's missing arguments from
 * `slots` before dispatch, short-circuits (without ever calling executeTool/the real HMS
 * API) if required arguments are still missing after backfill, and merges the
 * (backfilled) arguments back into `slots` afterward -- `slots` is mutated in place,
 * matching how `history` is mutated via .push() throughout this file.
 *
 * `touchedSlots` mirrors every merge into `slots` but is never reset by
 * clearBookingSlots -- see RunTurnResult.formFieldsThisTurn's doc comment for why a
 * separate, never-cleared accumulator is needed for the UI push. */
async function runToolCalls(opts: {
  toolCalls: ToolCall[];
  session: DialogueSession;
  hms: HmsClient;
  faqRetriever: HybridRetriever | undefined;
  hospitalReferenceRetriever: HybridRetriever | undefined;
  history: ChatMessage[];
  toolCallsExecuted: string[];
  slots: Record<string, unknown>;
  touchedSlots: Record<string, unknown>;
}): Promise<void> {
  const { toolCalls, session, hms, faqRetriever, hospitalReferenceRetriever, history, toolCallsExecuted, slots, touchedSlots } = opts;

  for (const call of toolCalls) {
    let resultText: string;
    // Set once RBAC passes and backfill runs -- stays undefined for a ForbiddenError, so
    // the catch block below can tell "never got past authorization" (no merge) apart from
    // "authorized but the call itself failed" (still merge -- see that block's comment).
    let filledArgs: Record<string, unknown> | undefined;
    try {
      // Checked explicitly here, before backfill/validation, so authorization always wins
      // -- executeTool below does this exact same check again internally (its own
      // independently-tested contract), a deliberate, harmless redundancy needed only to
      // control ordering relative to the missing-required-fields check, which lives
      // outside executeTool.
      assertToolPermission(call.name, session.role);

      filledArgs = backfillArgsFromSlots(call.name, call.arguments, slots, TOOL_SCHEMAS);
      const missing = missingRequiredArgs(call.name, filledArgs, TOOL_SCHEMAS);

      if (missing.length > 0) {
        // Short-circuits before ever calling executeTool/the real HMS API -- also closes a
        // real, currently-silent backend bug: easyHMSAPI only validates doctorId/mobile
        // server-side (Success:false with HTTP 200, not a thrown error), not
        // patientName/preferredDate, so a missing preferredDate today silently proceeds
        // with a zero-value date without this check.
        recordAuditEvent({
          ts: Date.now(),
          sessionId: session.sessionId,
          userId: session.userId,
          role: session.role,
          action: `tool_call:${call.name}`,
          outcome: 'error',
        });
        resultText = JSON.stringify({
          error: `Missing required field(s) for ${call.name}: ${missing.join(', ')}. Ask the caller for these before trying again.`,
          missingFields: missing,
        });
        mergeSlots(slots, filledArgs); // whatever the user DID give this call is still worth keeping
        mergeSlots(touchedSlots, filledArgs);
        history.push({ role: 'tool', content: resultText, tool_call_id: call.id, name: call.name });
        continue;
      }

      const toolResult = await executeTool(call.name, filledArgs, session.role, hms, faqRetriever, hospitalReferenceRetriever);
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.role,
        action: `tool_call:${call.name}`,
        outcome: 'success',
      });
      toolCallsExecuted.push(call.name);
      resultText = JSON.stringify(toolResult);
      mergeSlots(slots, filledArgs);
      mergeSlots(touchedSlots, filledArgs);
      // A successful booking closes that patient's slot-fill -- without this, a second
      // patient booked later in the same call could silently inherit the first patient's
      // stale name/mobile/date/doctor via backfill (see clearBookingSlots's doc comment
      // for the accepted, narrower residual risk this doesn't cover). Only `slots` is
      // cleared, deliberately NOT `touchedSlots` -- the UI should still see the
      // just-booked patient's details once, even though internal backfill state resets
      // right after for the next booking.
      if (call.name === 'book_appointment' && (toolResult as { success?: boolean } | null)?.success === true) {
        clearBookingSlots(slots);
      }
    } catch (err) {
      const outcome = err instanceof ForbiddenError ? 'denied' : 'error';
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.role,
        action: `tool_call:${call.name}`,
        outcome,
      });
      resultText = JSON.stringify({
        error: err instanceof ForbiddenError || err instanceof UnknownToolError ? err.message : 'Tool call failed',
      });
      // Authorized but the dispatch itself failed (e.g. UnknownToolError, a transient HMS
      // API error) -- the user's stated values are still real and worth keeping for a
      // retry. filledArgs stays undefined for a ForbiddenError (thrown before backfill
      // ever ran), so an unauthorized call's arguments never leak into future authorized
      // calls' backfill.
      if (filledArgs) {
        mergeSlots(slots, filledArgs);
        mergeSlots(touchedSlots, filledArgs);
      }
    }

    history.push({
      role: 'tool',
      content: resultText,
      tool_call_id: call.id,
      name: call.name,
    });
  }
}

export async function runTurn(opts: {
  session: DialogueSession;
  transcript: string;
  brain: BrainProvider;
  /** TTS only -- this function never transcribes audio, only synthesizes the reply. */
  tts: TtsProvider;
  hms: HmsClient;
  /** Optional so every existing caller/test keeps compiling unchanged -- see
   * executeTool's doc comment in tools.js for the same reasoning. */
  faqRetriever?: HybridRetriever;
  /** Same reasoning as faqRetriever above -- powers search_hospital_reference. */
  hospitalReferenceRetriever?: HybridRetriever;
  /** Optional -- when provided, streams the reply sentence-by-sentence via this callback
   * as each sentence is synthesized (the real-time WS path). Absent for every HTTP JSON
   * route, which keeps runTurn's behavior byte-for-byte identical to before streaming
   * existed: brain.chat() (non-streaming), one tts.synthesize() call at the end. */
  onReplyChunk?: (chunk: { text: string; audio: Uint8Array; isFinal: boolean }) => void;
  /** Checked before each tool-round while streaming, so a barge-in stops further
   * generation instead of wastefully continuing a reply nobody will hear. Ignored unless
   * onReplyChunk is also provided. */
  isAborted?: () => boolean;
}): Promise<RunTurnResult> {
  const { session, transcript, brain, tts, hms, faqRetriever, hospitalReferenceRetriever, onReplyChunk, isAborted } = opts;
  const model = modelForRole(session.role);
  // Upfront RBAC: the tool list offered to the model this turn never includes a tool
  // this role can't call (see tools.ts's toolSchemasForRole) -- computed once, since
  // session.role never changes for a session's lifetime.
  const availableTools = toolSchemasForRole(session.role);
  const toolCallsExecuted: string[] = [];
  // Seeded from whatever this session already knows; backfilled/merged in place across
  // every tool call this turn (see slots.ts / runToolCalls above).
  const slots: Record<string, unknown> = { ...(session.slots ?? {}) };
  // High-water mark for the UI push -- see RunTurnResult.formFieldsThisTurn's doc comment.
  const touchedSlots: Record<string, unknown> = { ...slots };

  const history: ChatMessage[] = session.history.length > 0
    ? [...session.history]
    : [{ role: 'system', content: buildSystemPrompt(session.role) }];
  history.push({ role: 'user', content: transcript });

  if (!onReplyChunk) {
    // --- Non-streaming path: unchanged behavior from before chatStream() existed. ---
    let replyText: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await brain.chat(history, availableTools, model);

      if (result.toolCalls.length === 0) {
        replyText = result.content ?? '';
        history.push({ role: 'assistant', content: replyText });
        break;
      }

      // Groq expects the assistant's tool-call request echoed back into history before
      // the tool results, even though we only track plain text content here -- record a
      // placeholder so the transcript stays coherent for logging/debugging.
      history.push({
        role: 'assistant',
        content: result.content ?? `[requested: ${result.toolCalls.map((t) => t.name).join(', ')}]`,
      });

      await runToolCalls({ toolCalls: result.toolCalls, session, hms, faqRetriever, hospitalReferenceRetriever, history, toolCallsExecuted, slots, touchedSlots });
    }

    if (replyText === null) {
      // Hit MAX_TOOL_ROUNDS without a final answer -- never hang a live call waiting on
      // a model that keeps requesting tools indefinitely.
      replyText = MAX_TOOL_ROUNDS_FALLBACK_MESSAGE;
      history.push({ role: 'assistant', content: replyText });
    }

    // normalizePhonetics is applied only to what's actually spoken -- replyText (returned
    // below, and already pushed into history above) stays exactly what the LLM said, so
    // the transcript/history are never rewritten, only the synthesized audio changes.
    const audio = await tts.synthesize(normalizePhonetics(replyText));
    return {
      replyText,
      audio,
      toolCallsExecuted,
      updatedHistory: history,
      updatedSlots: slots,
      formFieldsThisTurn: diffSlots(session.slots, touchedSlots),
    };
  }

  // --- Streaming path ---
  //
  // Every round's streamed content gets spoken as it arrives, regardless of whether that
  // round also ends up requesting a tool call -- for a voice assistant, an audible
  // acknowledgment ("Let me check that...") while a tool call is in flight is good,
  // natural UX, not an edge case to suppress. This keeps replyText/audio consistent by
  // construction: both are built from exactly what was actually spoken, turn-wide, not
  // just the final round's content. The history array's per-round entries are a separate
  // concern (what the LLM sees next turn) and keep today's exact real-content-or-
  // placeholder logic, independent of synthesis outcome.
  let spokenText = '';
  const spokenAudioChunks: Uint8Array[] = [];
  let pendingSentence: string | null = null;
  let ttsFailure: string | undefined;
  // TS doesn't retain the `!onReplyChunk` early-return's narrowing across the nested
  // function boundaries below -- alias it to a definitely-defined const once, here.
  const emitChunk = onReplyChunk;

  // Holds back the most recently completed sentence instead of speaking it immediately,
  // so the LAST thing ever emitted (in flushFinal, once we truly know nothing more is
  // coming) can reliably be marked isFinal:true -- the gateway/client need that signal to
  // know when a turn's audio is really over (see relay.ts's speak()).
  async function enqueueSentence(sentence: string): Promise<boolean> {
    if (pendingSentence !== null) {
      try {
        // Same spoken-vs-displayed split as the non-streaming path above: only the TTS
        // input is normalized -- spokenText/emitChunk's `text` stay the LLM's own words.
        const audio = await tts.synthesize(normalizePhonetics(pendingSentence));
        spokenText += pendingSentence;
        spokenAudioChunks.push(audio);
        emitChunk({ text: pendingSentence, audio, isFinal: false });
      } catch (err) {
        ttsFailure = err instanceof Error ? err.message : String(err);
        pendingSentence = sentence;
        return false;
      }
    }
    pendingSentence = sentence;
    return true;
  }

  async function flushFinal(): Promise<void> {
    const text = pendingSentence ?? '';
    pendingSentence = null;
    let audio: Uint8Array = new Uint8Array(0);
    if (text && !ttsFailure) {
      try {
        audio = await tts.synthesize(normalizePhonetics(text));
        spokenText += text;
        spokenAudioChunks.push(audio);
      } catch (err) {
        ttsFailure = err instanceof Error ? err.message : String(err);
        audio = new Uint8Array(0);
      }
    }
    emitChunk({ text: audio.length > 0 ? text : '', audio, isFinal: true });
  }

  roundLoop: for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (isAborted?.()) break;

    let content = '';
    let sentenceBuffer = '';
    let toolCalls: ToolCall[] = [];

    for await (const streamChunk of brain.chatStream(history, availableTools, model)) {
      if (streamChunk.contentDelta) {
        content += streamChunk.contentDelta;
        sentenceBuffer += streamChunk.contentDelta;
        const { complete, remainder } = splitCompletedSentences(sentenceBuffer);
        sentenceBuffer = remainder;
        for (const sentence of complete) {
          if (!(await enqueueSentence(sentence))) break roundLoop;
        }
      }
      if (streamChunk.done && streamChunk.toolCalls) {
        toolCalls = streamChunk.toolCalls;
      }
    }

    if (sentenceBuffer.trim() && !(await enqueueSentence(sentenceBuffer))) break;

    if (toolCalls.length === 0) {
      history.push({ role: 'assistant', content });
      break;
    }

    history.push({
      role: 'assistant',
      content: content || `[requested: ${toolCalls.map((t) => t.name).join(', ')}]`,
    });
    await runToolCalls({ toolCalls, session, hms, faqRetriever, hospitalReferenceRetriever, history, toolCallsExecuted, slots, touchedSlots });

    if (round === MAX_TOOL_ROUNDS - 1) {
      // Hit the cap without a final answer -- same fallback as the non-streaming path.
      await enqueueSentence(MAX_TOOL_ROUNDS_FALLBACK_MESSAGE);
      history.push({ role: 'assistant', content: MAX_TOOL_ROUNDS_FALLBACK_MESSAGE });
    }
  }

  await flushFinal();

  return {
    replyText: spokenText,
    audio: Buffer.concat(spokenAudioChunks),
    toolCallsExecuted,
    updatedHistory: history,
    updatedSlots: slots,
    formFieldsThisTurn: diffSlots(session.slots, touchedSlots),
    error: ttsFailure,
  };
}
