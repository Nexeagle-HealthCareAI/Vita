import { describe, expect, it, vi } from 'vitest';
import { SarvamSttProvider } from '../../src/stt/sarvam.js';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

const STT_URL = 'https://api.sarvam.ai/speech-to-text-streaming';

describe('SarvamSttProvider', () => {
  it('transcribe posts audio and returns the transcript text', async () => {
    const fetchImpl = fakeFetch({ transcript: 'book an appointment for tomorrow' });
    const client = new SarvamSttProvider('key', STT_URL, fetchImpl);

    const result = await client.transcribe(new Uint8Array([1, 2, 3]));

    expect(result.text).toBe('book an appointment for tomorrow');
    expect(fetchImpl).toHaveBeenCalledWith(STT_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('transcribe throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ error: 'bad audio' }, false, 400);
    const client = new SarvamSttProvider('key', STT_URL, fetchImpl);
    await expect(client.transcribe(new Uint8Array([1]))).rejects.toThrow(/400/);
  });
});
