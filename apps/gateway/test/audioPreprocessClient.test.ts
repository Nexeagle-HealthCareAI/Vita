import { describe, expect, it, vi } from 'vitest';
import { AudioPreprocessClient } from '../src/audioPreprocessClient.js';

function fakeFetch(opts: { ok?: boolean; status?: number; body?: Uint8Array; speechDetected?: boolean } = {}) {
  const { ok = true, status = 200, body = new Uint8Array([1, 2, 3]), speechDetected = true } = opts;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    headers: { get: (name: string) => (name.toLowerCase() === 'x-tera-speech-detected' ? (speechDetected ? '1' : '0') : null) },
  }) as unknown as typeof fetch;
}

describe('AudioPreprocessClient', () => {
  it('process() posts to /session/{id}/process and maps the response', async () => {
    const fetchImpl = fakeFetch({ body: new Uint8Array([9, 8, 7]), speechDetected: true });
    const client = new AudioPreprocessClient('http://audio-preprocess:8090', fetchImpl);

    const result = await client.process(new Uint8Array([1, 2, 3]), 'sess-1');

    expect(result.speechDetected).toBe(true);
    expect(Array.from(result.frame)).toEqual([9, 8, 7]);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://audio-preprocess:8090/session/sess-1/process');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('process() URL-encodes the session id', async () => {
    const fetchImpl = fakeFetch();
    const client = new AudioPreprocessClient('http://audio-preprocess:8090', fetchImpl);

    await client.process(new Uint8Array([1]), 'sess/with space');

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://audio-preprocess:8090/session/sess%2Fwith%20space/process');
  });

  it('process() throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 502 });
    const client = new AudioPreprocessClient('http://audio-preprocess:8090', fetchImpl);

    await expect(client.process(new Uint8Array([1]), 'sess-1')).rejects.toThrow(/502/);
  });

  it('teardown() issues a DELETE to /session/{id}', async () => {
    const fetchImpl = fakeFetch();
    const client = new AudioPreprocessClient('http://audio-preprocess:8090', fetchImpl);

    await client.teardown('sess-1');

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://audio-preprocess:8090/session/sess-1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('teardown() throws a descriptive error on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500 });
    const client = new AudioPreprocessClient('http://audio-preprocess:8090', fetchImpl);

    await expect(client.teardown('sess-1')).rejects.toThrow(/500/);
  });
});
