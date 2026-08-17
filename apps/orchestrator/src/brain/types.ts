/**
 * Vendor-agnostic "brain" (LLM) layer. pipeline.ts depends on BrainProvider, not on
 * "Groq" directly, so a different LLM vendor could be swapped in later without touching
 * turn-orchestration logic. groq.ts's GroqBrainProvider is the only implementation today.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Only present on role:'tool' messages -- ties the result back to the tool_call that requested it. */
  tool_call_id?: string;
  /** Only present on role:'tool' messages -- the tool name, per OpenAI's function-calling contract. */
  name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResult {
  /** null when the model only requested tool calls and produced no text this round. */
  content: string | null;
  toolCalls: ToolCall[];
}

/** One piece of a streamed chat completion. `contentDelta` arrives incrementally as the
 * model generates text; `toolCalls` is only ever populated on the final (done:true) chunk,
 * once every tool-call argument fragment across the whole stream has been reassembled --
 * there's no meaningful "partial" tool call to hand a caller mid-stream. */
export interface BrainStreamChunk {
  contentDelta?: string;
  toolCalls?: ToolCall[];
  done: boolean;
}

/** One conversational turn: history + available tools + model in, a reply and/or tool
 * calls out. OpenAI-compatible function-calling shape (ToolSchema/ToolCall) -- shared by
 * enough real vendors (Groq, OpenAI, and other OpenAI-compatible APIs) that it's a
 * reasonable lingua franca for this interface, not a Groq-specific leak.
 *
 * chat() and chatStream() stay on one interface rather than splitting like
 * SttProvider/StreamingSttSession do -- that split exists because batch and streaming STT
 * are structurally different (session-shaped vs one-shot) and used by mutually exclusive
 * call sites. Here both methods take identical input and differ only in delivery shape,
 * and the same caller (pipeline.ts's runTurn) legitimately wants either depending on who
 * called *it* -- unifying is the correct shape, not a forced compromise. */
export interface BrainProvider {
  chat(messages: ChatMessage[], tools: ToolSchema[], model: string): Promise<ChatResult>;
  chatStream(messages: ChatMessage[], tools: ToolSchema[], model: string): AsyncIterable<BrainStreamChunk>;
}
