import type { HmsClient } from '@vita/mcp-1hms';
import { GroqClient, type ChatMessage } from './groq.js';
import { SarvamClient } from './sarvam.js';
import { GROQ_TOOL_SCHEMAS, executeTool, UnknownToolError } from './tools.js';
import { ForbiddenError } from './rbac.js';
import { recordAuditEvent } from './audit.js';
import type { DialogueSession } from './session.js';

const MAX_TOOL_ROUNDS = 3;

const SYSTEM_PROMPT =
  'You are Vita, a voice assistant helping hospital front-desk staff and doctors. ' +
  'Be concise -- your replies are spoken aloud. Use the available tools to register ' +
  'patients, check appointment slot availability, and book appointments. Never invent ' +
  'patient, doctor, or slot information -- only state what a tool call actually returned.';

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
}): Promise<RunTurnResult> {
  const { session, transcript, groq, sarvam, hms } = opts;
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
        const toolResult = await executeTool(call.name, call.arguments, session.role, hms);
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
