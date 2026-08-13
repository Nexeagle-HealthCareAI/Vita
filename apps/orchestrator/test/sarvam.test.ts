import { describe, expect, it, vi } from 'vitest';
import { SarvamClient } from '../src/sarvam.js';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

const STT_URL = 'https://api.sarvam.ai/speech-to-text-streaming';
const TTS_URL = 'https://api.sarvam.ai/text-to-speech';

describe('SarvamClient', () => {
  it('transcribe posts audio and returns the transcript text', async () => {
    const fetchImpl = fakeFetch({ transcript: 'book an appointment for tomorrow' });
    const client = new SarvamClient('key', STT_URL, TTS_URL, fetchImpl);

    const result = await client.transcribe(new Uint8Array([1, 2, 3]));

    expect(result.text).toBe('book an appointment for tomorrow');
    expect(fetchImpl).toHaveBeenCalledWith(STT_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('transcribe throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ error: 'bad audio' }, false, 400);
    const client = new SarvamClient('key', STT_URL, TTS_URL, fetchImpl);
    await expect(client.transcribe(new Uint8Array([1]))).rejects.toThrow(/400/);
  });

  it('synthesize posts text and decodes the base64 audio into bytes', async () => {
    const originalBytes = new Uint8Array([10, 20, 30, 40]);
    const base64Audio = Buffer.from(originalBytes).toString('base64');
    const fetchImpl = fakeFetch({ audios: [base64Audio] });
    const client = new SarvamClient('key', STT_URL, TTS_URL, fetchImpl);

    const audio = await client.synthesize('Your appointment is confirmed.');

    expect(Array.from(audio)).toEqual(Array.from(originalBytes));
    expect(fetchImpl).toHaveBeenCalledWith(TTS_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('synthesize throws if the response has no audio', async () => {
    const fetchImpl = fakeFetch({ audios: [] });
    const client = new SarvamClient('key', STT_URL, TTS_URL, fetchImpl);
    await expect(client.synthesize('hi')).rejects.toThrow(/no audio/);
  });

  it('synthesize throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ error: 'invalid text' }, false, 422);
    const client = new SarvamClient('key', STT_URL, TTS_URL, fetchImpl);
    await expect(client.synthesize('hi')).rejects.toThrow(/422/);
  });
});
