import { describe, expect, it, vi } from 'vitest';
import { GroqBrainProvider } from '../../src/brain/groq.js';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

/** Builds a real web-standard ReadableStream of SSE-formatted bytes, one "data: <json>\n\n"
 * line per event (or a literal "data: [DONE]\n\n" for the '[DONE]' sentinel) -- the shape
 * chatStream()'s `res.body.getReader()` parsing expects. fakeFetch()'s plain json()/text()
 * object can't stand in for this since chatStream() never calls those, only reads `body`. */
function sseBody(events: (object | '[DONE]')[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = events.map((e) => `data: ${e === '[DONE]' ? '[DONE]' : JSON.stringify(e)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function fakeStreamFetch(events: (object | '[DONE]')[], ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    body: sseBody(events),
    text: async () => 'stream error',
  }) as unknown as typeof fetch;
}

async function collectStream(iter: AsyncIterable<{ contentDelta?: string; toolCalls?: unknown; done: boolean }>) {
  const chunks: { contentDelta?: string; toolCalls?: unknown; done: boolean }[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

describe('GroqBrainProvider', () => {
  it('returns plain text content when the model makes no tool calls', async () => {
    const fetchImpl = fakeFetch({
      choices: [{ message: { content: 'Hello, how can I help?', tool_calls: undefined } }],
    });
    const client = new GroqBrainProvider('key', fetchImpl);
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
    const client = new GroqBrainProvider('key', fetchImpl);
    const result = await client.chat([{ role: 'user', content: 'any slots tomorrow?' }], [], 'llama-3.1-8b-instant');

    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'check_slot_availability', arguments: { department: 'Cardiology', date: '2026-08-20' } },
    ]);
  });

  it('sends the requested model and message history through unchanged', async () => {
    const fetchImpl = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
    const client = new GroqBrainProvider('key', fetchImpl);
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
    const client = new GroqBrainProvider('key', fetchImpl);
    await expect(client.chat([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant')).rejects.toThrow(/429/);
  });

  it('posts to a custom apiUrl when one is provided, instead of the real Groq endpoint', async () => {
    const fetchImpl = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
    const client = new GroqBrainProvider('key', fetchImpl, 'http://localhost:9999/groq/chat/completions');
    await client.chat([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant');

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:9999/groq/chat/completions', expect.any(Object));
  });

  describe('chatStream', () => {
    it('yields content deltas as they arrive, then a final done:true chunk with no toolCalls', async () => {
      const fetchImpl = fakeStreamFetch([
        { choices: [{ delta: { content: 'Sure, ' } }] },
        { choices: [{ delta: { content: 'one moment.' } }] },
        '[DONE]',
      ]);
      const client = new GroqBrainProvider('key', fetchImpl);

      const chunks = await collectStream(client.chatStream([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant'));

      expect(chunks).toEqual([
        { contentDelta: 'Sure, ', done: false },
        { contentDelta: 'one moment.', done: false },
        { done: true, toolCalls: undefined },
      ]);
    });

    it('reassembles tool_calls whose arguments arrive split across multiple deltas, keyed by index', async () => {
      const fetchImpl = fakeStreamFetch([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'check_doctor_availability' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"doctorId":"d-1",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"date":"2026-08-20"}' } }] } }] },
        '[DONE]',
      ]);
      const client = new GroqBrainProvider('key', fetchImpl);

      const chunks = await collectStream(client.chatStream([{ role: 'user', content: 'is dr patel around?' }], [], 'llama-3.1-8b-instant'));

      expect(chunks).toEqual([
        { done: true, toolCalls: [{ id: 'call_1', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', date: '2026-08-20' } }] },
      ]);
    });

    it('sends stream:true in the request body', async () => {
      const fetchImpl = fakeStreamFetch([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']);
      const client = new GroqBrainProvider('key', fetchImpl);
      await collectStream(client.chatStream([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant'));

      const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.stream).toBe(true);
    });

    it('throws a descriptive error on a non-OK response, mirroring chat()', async () => {
      const fetchImpl = fakeStreamFetch([], false, 503);
      const client = new GroqBrainProvider('key', fetchImpl);
      await expect(collectStream(client.chatStream([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant'))).rejects.toThrow(/503/);
    });
  });
});
