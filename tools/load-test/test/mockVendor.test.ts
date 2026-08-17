import { afterEach, describe, expect, it } from 'vitest';
import { SarvamSttProvider } from '@vita/orchestrator/dist/stt/sarvam.js';
import { SarvamTtsProvider } from '@vita/orchestrator/dist/tts/sarvam.js';
import { GroqBrainProvider } from '@vita/orchestrator/dist/brain/groq.js';
import { buildMockVendor } from '../src/mockVendor.js';

/** Builds the real SarvamSttProvider/SarvamTtsProvider/GroqBrainProvider (the exact
 * classes apps/orchestrator uses against the real vendors) pointed at the stub, and
 * asserts they parse it successfully -- this is what would actually catch drift if
 * stt/sarvam.ts's/tts/sarvam.ts's/brain/groq.ts's real request/response parsing ever
 * changes underneath this stub, unlike a test that only exercises the stub's own
 * routes in isolation. */
describe('mockVendor contract (real SarvamSttProvider/SarvamTtsProvider/GroqBrainProvider against the stub)', () => {
  let app: ReturnType<typeof buildMockVendor> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function listen(): Promise<string> {
    app = buildMockVendor({ sttDelayMs: 0 });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');
    return `http://127.0.0.1:${address.port}`;
  }

  it('SarvamSttProvider.transcribe() successfully parses the stub STT response', async () => {
    const baseUrl = await listen();
    const client = new SarvamSttProvider('mock-key', `${baseUrl}/sarvam/stt`);

    const result = await client.transcribe(new Uint8Array([1, 2, 3]));
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('SarvamTtsProvider.synthesize() successfully parses the stub TTS response', async () => {
    const baseUrl = await listen();
    const client = new SarvamTtsProvider('mock-key', `${baseUrl}/sarvam/tts`);

    const audio = await client.synthesize('hello');
    expect(audio.length).toBeGreaterThan(0);
  });

  it('GroqBrainProvider.chat() successfully parses the stub chat-completions response', async () => {
    const baseUrl = await listen();
    const client = new GroqBrainProvider('mock-key', undefined, `${baseUrl}/groq/chat/completions`);

    const result = await client.chat([{ role: 'user', content: 'hi' }], [], 'llama-3.1-8b-instant');
    expect(result.content).toBeTruthy();
    expect(result.toolCalls).toEqual([]);
  });

  it('GET /healthz responds ok', async () => {
    const baseUrl = await listen();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.ok).toBe(true);
  });
});
