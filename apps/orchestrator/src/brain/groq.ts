/**
 * Thin typed client over Groq's OpenAI-compatible Chat Completions API. Kept separate
 * from the turn-orchestration logic (pipeline.ts) so it can be unit-tested against a
 * mocked HTTP layer without any real network access — same pattern as
 * packages/mcp-1hms/src/hmsClient.ts (constructor-injected fetch).
 */
import type { BrainProvider, ChatMessage, ChatResult, ToolCall, ToolSchema } from './types.js';

const DEFAULT_GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export class GroqBrainProvider implements BrainProvider {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    // Configurable for the same reason the STT/TTS providers' endpoints already are --
    // lets tools/load-test point a real GroqBrainProvider at a local mock-vendor stub
    // instead of the real (paid, non-deterministic) API, without touching pipeline.ts.
    private apiUrl: string = DEFAULT_GROQ_API_URL,
  ) {}

  async chat(messages: ChatMessage[], tools: ToolSchema[], model: string): Promise<ChatResult> {
    const res = await this.fetchImpl(this.apiUrl, {
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
