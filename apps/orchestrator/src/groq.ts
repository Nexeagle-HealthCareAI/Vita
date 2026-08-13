/**
 * Thin typed client over Groq's OpenAI-compatible Chat Completions API. Kept separate
 * from the turn-orchestration logic (pipeline.ts) so it can be unit-tested against a
 * mocked HTTP layer without any real network access — same pattern as
 * packages/mcp-1hms/src/hmsClient.ts (constructor-injected fetch).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Only present on role:'tool' messages -- ties the result back to the tool_call that requested it. */
  tool_call_id?: string;
  /** Only present on role:'tool' messages -- the tool name, per OpenAI's function-calling contract. */
  name?: string;
}

export interface GroqToolSchema {
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

export interface GroqChatResult {
  /** null when the model only requested tool calls and produced no text this round. */
  content: string | null;
  toolCalls: ToolCall[];
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export class GroqClient {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[], tools: GroqToolSchema[], model: string): Promise<GroqChatResult> {
    const res = await this.fetchImpl(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Groq chat completion failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices: {
        message: {
          content: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };

    const message = data.choices[0]?.message;
    if (!message) {
      throw new Error('Groq chat completion returned no choices');
    }

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      // Arguments come back as a JSON string per OpenAI's function-calling contract, not a parsed object.
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return { content: message.content, toolCalls };
  }
}
