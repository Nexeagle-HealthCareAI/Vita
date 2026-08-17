import type { HmsClient } from '@vita/mcp-1hms';
import type { HybridRetriever } from '@vita/rag';
import type { BrainProvider, ChatMessage, ToolCall } from './brain/types.js';
import type { TtsProvider } from './tts/types.js';
import { TOOL_SCHEMAS, executeTool, UnknownToolError } from './tools.js';
import { ForbiddenError } from './rbac.js';
import { recordAuditEvent } from './audit.js';
import type { DialogueSession } from './session.js';
import { splitCompletedSentences } from './sentenceSplitter.js';

const MAX_TOOL_ROUNDS = 3;

const SYSTEM_PROMPT =
  'You are Vita, a voice assistant helping hospital front-desk staff and doctors. ' +
  'Be concise -- your replies are spoken aloud. Use find_doctors to locate a doctor by ' +
  'specialty/name/city, check_doctor_availability to see if they are working on a given ' +
  'date, and book_appointment to request an appointment (this also registers the patient ' +
  '-- there is no separate registration step). Bookings are non-binding requests; the ' +
  'exact time is confirmed by hospital staff afterward, so never tell a patient their ' +
  'time is final. Use search_vita_faq for generic questions about Vita itself (what it is, ' +
  'what it can do, where it runs, etc.) rather than the hospital tools above. Never invent ' +
  'patient, doctor, availability, or Vita-related information -- only state what a tool ' +
  'call actually returned.';

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
  /** Streaming path only (see onReplyChunk below) -- set when a mid-turn TTS failure cut
   * the reply short. history/audio/replyText above still reflect exactly what was
   * actually said before the failure (never silently discarded), so the caller should
   * still persist them; this field is what tells it to also surface an error afterward. */
  error?: string;
}

const MAX_TOOL_ROUNDS_FALLBACK_MESSAGE = "Sorry, I'm having trouble completing that right now. Could you repeat what you need?";

/** Executes every tool call in `toolCalls` against `hms`/`retriever`, RBAC-checked and
 * audited, appending a role:'tool' history entry per call -- shared by both the
 * non-streaming and streaming paths below, which otherwise differ significantly in how
 * they get from history to a spoken reply. */
async function runToolCalls(
  toolCalls: ToolCall[],
  session: DialogueSession,
  hms: HmsClient,
  retriever: HybridRetriever | undefined,
  history: ChatMessage[],
  toolCallsExecuted: string[],
): Promise<void> {
  for (const call of toolCalls) {
    let resultText: string;
    try {
      const toolResult = await executeTool(call.name, call.arguments, session.role, hms, retriever);
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
  retriever?: HybridRetriever;
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
  const { session, transcript, brain, tts, hms, retriever, onReplyChunk, isAborted } = opts;
  const model = modelForRole(session.role);
  const toolCallsExecuted: string[] = [];

  const history: ChatMessage[] = session.history.length > 0
    ? [...session.history]
    : [{ role: 'system', content: SYSTEM_PROMPT }];
  history.push({ role: 'user', content: transcript });

  if (!onReplyChunk) {
    // --- Non-streaming path: unchanged behavior from before chatStream() existed. ---
    let replyText: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await brain.chat(history, TOOL_SCHEMAS, model);

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

      await runToolCalls(result.toolCalls, session, hms, retriever, history, toolCallsExecuted);
    }

    if (replyText === null) {
      // Hit MAX_TOOL_ROUNDS without a final answer -- never hang a live call waiting on
      // a model that keeps requesting tools indefinitely.
      replyText = MAX_TOOL_ROUNDS_FALLBACK_MESSAGE;
      history.push({ role: 'assistant', content: replyText });
    }

    const audio = await tts.synthesize(replyText);
    return { replyText, audio, toolCallsExecuted, updatedHistory: history };
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
        const audio = await tts.synthesize(pendingSentence);
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
        audio = await tts.synthesize(text);
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

    for await (const streamChunk of brain.chatStream(history, TOOL_SCHEMAS, model)) {
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
    await runToolCalls(toolCalls, session, hms, retriever, history, toolCallsExecuted);

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
    error: ttsFailure,
  };
}
