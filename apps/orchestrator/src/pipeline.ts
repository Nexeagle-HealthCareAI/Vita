import type { HmsClient } from '@vita/mcp-1hms';
import type { HybridRetriever } from '@vita/rag';
import { GroqClient, type ChatMessage } from './groq.js';
import { SarvamClient } from './sarvam.js';
import { GROQ_TOOL_SCHEMAS, executeTool, UnknownToolError } from './tools.js';
import { ForbiddenError } from './rbac.js';
import { recordAuditEvent } from './audit.js';
import type { DialogueSession } from './session.js';

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
}

export async function runTurn(opts: {
  session: DialogueSession;
  transcript: string;
  groq: GroqClient;
  sarvam: SarvamClient;
  hms: HmsClient;
  /** Optional so every existing caller/test keeps compiling unchanged -- see
   * executeTool's doc comment in tools.js for the same reasoning. */
  retriever?: HybridRetriever;
}): Promise<RunTurnResult> {
  const { session, transcript, groq, sarvam, hms, retriever } = opts;
  const model = modelForRole(session.role);
  const toolCallsExecuted: string[] = [];

  const history: ChatMessage[] = session.history.length > 0
    ? [...session.history]
    : [{ role: 'system', content: SYSTEM_PROMPT }];
  history.push({ role: 'user', content: transcript });

  let replyText: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await groq.chat(history, GROQ_TOOL_SCHEMAS, model);

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

    for (const call of result.toolCalls) {
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

  if (replyText === null) {
    // Hit MAX_TOOL_ROUNDS without a final answer -- never hang a live call waiting on
    // a model that keeps requesting tools indefinitely.
    replyText = "Sorry, I'm having trouble completing that right now. Could you repeat what you need?";
    history.push({ role: 'assistant', content: replyText });
  }

  const audio = await sarvam.synthesize(replyText);

  return { replyText, audio, toolCallsExecuted, updatedHistory: history };
}
