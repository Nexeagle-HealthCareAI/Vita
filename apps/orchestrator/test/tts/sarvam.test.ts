import { describe, expect, it, vi } from 'vitest';
import { SarvamTtsProvider } from '../../src/tts/sarvam.js';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

const TTS_URL = 'https://api.sarvam.ai/text-to-speech';

describe('SarvamTtsProvider', () => {
  it('synthesize posts text and decodes the base64 audio into bytes', async () => {
    const originalBytes = new Uint8Array([10, 20, 30, 40]);
    const base64Audio = Buffer.from(originalBytes).toString('base64');
    const fetchImpl = fakeFetch({ audios: [base64Audio] });
    const client = new SarvamTtsProvider('key', TTS_URL, fetchImpl);

    const audio = await client.synthesize('Your appointment is confirmed.');

    expect(Array.from(audio)).toEqual(Array.from(originalBytes));
    expect(fetchImpl).toHaveBeenCalledWith(TTS_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('synthesize throws if the response has no audio', async () => {
    const fetchImpl = fakeFetch({ audios: [] });
    const client = new SarvamTtsProvider('key', TTS_URL, fetchImpl);
    await expect(client.synthesize('hi')).rejects.toThrow(/no audio/);
  });

  it('synthesize throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ error: 'invalid text' }, false, 422);
    const client = new SarvamTtsProvider('key', TTS_URL, fetchImpl);
    await expect(client.synthesize('hi')).rejects.toThrow(/422/);
  });

  it('attaches an AbortSignal so a hung Sarvam connection can never freeze a call indefinitely', async () => {
    const fetchImpl = fakeFetch({ audios: [Buffer.from([1]).toString('base64')] });
    const client = new SarvamTtsProvider('key', TTS_URL, fetchImpl);
    await client.synthesize('hi');

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
