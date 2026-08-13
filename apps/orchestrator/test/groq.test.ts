import { describe, expect, it, vi } from 'vitest';
import { GroqClient } from '../src/groq.js';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

describe('GroqClient', () => {
  it('returns plain text content when the model makes no tool calls', async () => {
    const fetchImpl = fakeFetch({
      choices: [{ message: { content: 'Hello, how can I help?', tool_calls: undefined } }],
    });
    const client = new GroqClient('key', fetchImpl);
    const result = await client.chat([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant');

    expect(result.content).toBe('Hello, how can I help?');
    expect(result.toolCalls).toEqual([]);
  });

  it('parses tool_calls and their JSON-string arguments into objects', async () => {
    const fetchImpl = fakeFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'check_slot_availability',
                  arguments: JSON.stringify({ department: 'Cardiology', date: '2026-08-20' }),
                },
              },
            ],
          },
        },
      ],
    });
    const client = new GroqClient('key', fetchImpl);
    const result = await client.chat([{ role: 'user', content: 'any slots tomorrow?' }], [], 'llama-3.1-8b-instant');

    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'check_slot_availability', arguments: { department: 'Cardiology', date: '2026-08-20' } },
    ]);
  });

  it('sends the requested model and message history through unchanged', async () => {
    const fetchImpl = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
    const client = new GroqClient('key', fetchImpl);
    const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hi' }];
    await client.chat(messages, [], 'llama-3.1-70b-versatile');

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('llama-3.1-70b-versatile');
    expect(body.messages).toEqual(messages);
    expect(body.stream).toBe(false);
  });

  it('throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ error: 'rate limited' }, false, 429);
    const client = new GroqClient('key', fetchImpl);
    await expect(client.chat([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant')).rejects.toThrow(/429/);
  });
});
