import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { SarvamRealtimeSttSession, buildSarvamRealtimeUrl } from '../../src/stt/sarvamRealtime.js';

/** Real local ws.WebSocketServer standing in for Sarvam's realtime endpoint -- exercises
 * the actual wire protocol (real sockets, real JSON framing, real close codes) rather
 * than a mocked WebSocket class, per the streaming STT plan's Step 0 spike findings
 * (session.begin / transcript.partial / transcript.final / error / close-code shapes
 * verified directly against docs.sarvam.ai). */
describe('SarvamRealtimeSttSession', () => {
  let wss: WebSocketServer;
  let connectUrl: string;
  let session: SarvamRealtimeSttSession | undefined;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');
    connectUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    session?.end();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('connect() resolves once session.begin arrives, and sends the API-SUBSCRIPTION-KEY as a connect header (never in the URL)', async () => {
    let receivedHeader: string | undefined;
    wss.once('connection', (socket, req) => {
      receivedHeader = req.headers['api-subscription-key'] as string | undefined;
      socket.send(JSON.stringify({ event: 'session.begin', request_id: 'r-1', config: {} }));
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'secret-key');

    await expect(session.connect(1000)).resolves.toBeUndefined();
    expect(receivedHeader).toBe('secret-key');
    expect(connectUrl).not.toContain('secret-key');
  });

  it('routes transcript.partial then transcript.final to their handlers, in order', async () => {
    let serverSocket: WsWebSocket;
    wss.once('connection', (socket) => {
      serverSocket = socket;
      socket.send(JSON.stringify({ event: 'session.begin' }));
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');
    const received: string[] = [];
    session.onPartialTranscript((text) => received.push(`partial:${text}`));
    session.onFinalTranscript((text) => received.push(`final:${text}`));
    await session.connect(1000);

    serverSocket!.send(JSON.stringify({ event: 'transcript.partial', text: 'hel' }));
    serverSocket!.send(JSON.stringify({ event: 'transcript.final', text: 'hello' }));

    await vi.waitFor(() => expect(received).toEqual(['partial:hel', 'final:hello']));
  });

  it('a non-fatal error (e.g. invalid_config) does not fire onFatal and leaves the connection alive', async () => {
    let serverSocket: WsWebSocket;
    wss.once('connection', (socket) => {
      serverSocket = socket;
      socket.send(JSON.stringify({ event: 'session.begin' }));
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');
    const fatalHandler = vi.fn();
    session.onFatal(fatalHandler);
    await session.connect(1000);

    serverSocket!.send(JSON.stringify({ event: 'error', code: 'invalid_config', is_fatal: false, message: 'bad param' }));
    // Prove the connection is still usable afterward, not that nothing happens for 50ms.
    const partialHandler = vi.fn();
    session.onPartialTranscript(partialHandler);
    serverSocket!.send(JSON.stringify({ event: 'transcript.partial', text: 'still alive' }));

    await vi.waitFor(() => expect(partialHandler).toHaveBeenCalledWith('still alive'));
    expect(fatalHandler).not.toHaveBeenCalled();
  });

  it('a fatal error (is_fatal: true) fires onFatal with the message', async () => {
    let serverSocket: WsWebSocket;
    wss.once('connection', (socket) => {
      serverSocket = socket;
      socket.send(JSON.stringify({ event: 'session.begin' }));
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');
    const fatalHandler = vi.fn();
    session.onFatal(fatalHandler);
    await session.connect(1000);

    serverSocket!.send(JSON.stringify({ event: 'error', code: 'quota_exceeded', is_fatal: true, message: 'Credits exhausted', status_code: 402 }));

    await vi.waitFor(() => expect(fatalHandler).toHaveBeenCalledWith('Credits exhausted'));
  });

  it('close code 1003 (rate limit/quota) before session.begin rejects connect()', async () => {
    wss.once('connection', (socket) => {
      socket.close(1003, 'rate limited');
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');

    await expect(session.connect(1000)).rejects.toThrow(/code=1003/);
  });

  it('close code 1008 (inactivity timeout) after session.begin (mid-utterance) fires onFatal instead of hanging', async () => {
    let serverSocket: WsWebSocket;
    wss.once('connection', (socket) => {
      serverSocket = socket;
      socket.send(JSON.stringify({ event: 'session.begin' }));
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');
    const fatalHandler = vi.fn();
    session.onFatal(fatalHandler);
    await session.connect(1000);

    serverSocket!.close(1008, 'inactivity timeout');

    await vi.waitFor(() => expect(fatalHandler).toHaveBeenCalledWith(expect.stringContaining('code=1008')));
  });

  it('connect() rejects on timeout if the server never sends session.begin', async () => {
    wss.once('connection', () => {
      // never replies
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');

    await expect(session.connect(50)).rejects.toThrow(/timed out/);
  });

  it('sendSpeechStart/sendSpeechEnd/sendAudio write the documented wire shapes', async () => {
    const received: string[] = [];
    wss.once('connection', (socket) => {
      socket.send(JSON.stringify({ event: 'session.begin' }));
      socket.on('message', (data: Buffer) => received.push(data.toString()));
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');
    await session.connect(1000);

    session.sendSpeechStart();
    session.sendSpeechEnd();
    session.sendAudio(new Uint8Array([1, 2, 3]));

    await vi.waitFor(() => expect(received.length).toBe(3));
    expect(received[0]).toBe(JSON.stringify({ event: 'speech_start' }));
    expect(received[1]).toBe(JSON.stringify({ event: 'speech_end' }));
    expect(received[2]).toBe(JSON.stringify({ event: 'audio_input', audio: Buffer.from([1, 2, 3]).toString('base64') }));
  });

  it('end() sends an end event then closes the socket', async () => {
    const received: string[] = [];
    let closed = false;
    wss.once('connection', (socket) => {
      socket.send(JSON.stringify({ event: 'session.begin' }));
      socket.on('message', (data: Buffer) => received.push(data.toString()));
      socket.on('close', () => {
        closed = true;
      });
    });
    session = new SarvamRealtimeSttSession(connectUrl, 'key');
    await session.connect(1000);

    session.end();

    await vi.waitFor(() => expect(closed).toBe(true));
    expect(received).toContain(JSON.stringify({ event: 'end' }));
  });
});

describe('buildSarvamRealtimeUrl', () => {
  it('builds the documented query-param shape', () => {
    const url = buildSarvamRealtimeUrl({
      baseUrl: 'wss://api.sarvam.ai/speech-to-text-realtime/ws',
      languageCode: 'en-IN',
      streamType: 'fast',
    });

    expect(url).toBe(
      'wss://api.sarvam.ai/speech-to-text-realtime/ws?' +
        'language_code=en-IN&model=saaras%3Av3-realtime&stream_type=fast&mode=transcribe&endpointing=manual&encoding=linear16&sample_rate=16000',
    );
  });
});
