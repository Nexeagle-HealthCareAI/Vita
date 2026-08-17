/**
 * Thin typed client over Groq's OpenAI-compatible Chat Completions API. Kept separate
 * from the turn-orchestration logic (pipeline.ts) so it can be unit-tested against a
 * mocked HTTP layer without any real network access — same pattern as
 * packages/mcp-1hms/src/hmsClient.ts (constructor-injected fetch).
 */
import type { BrainProvider, BrainStreamChunk, ChatMessage, ChatResult, ToolCall, ToolSchema } from './types.js';

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

  /** Streams a chat completion as Server-Sent Events -- standard OpenAI-compatible shape:
   * lines prefixed "data: " each carrying one JSON delta, terminated by a literal
   * "data: [DONE]" line. Tool-call arguments arrive as fragments keyed by index and must
   * be concatenated across the whole stream, then parsed once, since a single JSON string
   * value is routinely split across many chunks.
   *
   * HONESTY NOTE: this exact SSE shape hasn't been verified against a live Groq call in
   * this session -- same caveat convention as stt/sarvam.ts's/tts/sarvam.ts's field-name
   * uncertainty. Adjust the parsing here first if a real response ever mismatches it. */
  async *chatStream(messages: ChatMessage[], tools: ToolSchema[], model: string): AsyncIterable<BrainStreamChunk> {
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
        stream: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`Groq chat completion failed: ${res.status} ${await res.text()}`);
    }
    if (!res.body) {
      throw new Error('Groq streaming chat completion returned no response body');
    }

    type StreamDelta = {
      choices: {
        delta: {
          content?: string | null;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const toolCallsByIndex = new Map<number, { id: string; name: string; argsJson: string }>();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // last line may be incomplete -- keep it for the next read

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice('data: '.length);
        if (payload === '[DONE]') continue;

        const parsed = JSON.parse(payload) as StreamDelta;
        const delta = parsed.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { contentDelta: delta.content, done: false };
        }

        for (const tc of delta.tool_calls ?? []) {
          const existing = toolCallsByIndex.get(tc.index) ?? { id: '', name: '', argsJson: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallsByIndex.values()].map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.parse(tc.argsJson || '{}') as Record<string, unknown>,
    }));
    yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }
}
