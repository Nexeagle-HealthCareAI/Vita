import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { buildServer } from '../src/index.js';
import { AudioPreprocessClient } from '../src/audioPreprocessClient.js';
import { OrchestratorClient } from '../src/orchestratorClient.js';

// buildServer's JWT_SECRET is read once at module load from JWT_SIGNING_SECRET, defaulting
// to 'change-me' -- same convention wsRelay.integration.test.ts relies on.
const JWT_SECRET = 'change-me';

function fakeAudioPreprocess() {
  const client = Object.create(AudioPreprocessClient.prototype) as AudioPreprocessClient;
  client.process = vi.fn(async (frame: Uint8Array) => ({ frame, speechDetected: false }));
  client.teardown = vi.fn().mockResolvedValue(undefined);
  return client;
}

function fakeOrchestrator() {
  const client = Object.create(OrchestratorClient.prototype) as OrchestratorClient;
  client.createSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1', resumeToken: 'tok-1' });
  client.resumeSession = vi.fn().mockResolvedValue(null);
  return client;
}

type SessionReady = { event: 'SESSION_READY'; sessionId: string; resumeToken: string; resumed: boolean };

function waitForSessionReady(ws: WebSocket): Promise<SessionReady> {
  return new Promise((resolve, reject) => {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as { event: string };
      if (msg.event === 'SESSION_READY') resolve(msg as SessionReady);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for SESSION_READY')), 5000);
  });
}

async function mintTicket(app: ReturnType<typeof buildServer>, resume?: { resumeSessionId: string; resumeToken: string }) {
  const token = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
  const res = await app.inject({
    method: 'POST',
    url: '/session/ticket',
    headers: { authorization: `Bearer ${token}` },
    payload: resume ?? {},
  });
  return (JSON.parse(res.body) as { ticket: string }).ticket;
}

describe('gateway WS resume -- reconnecting into the same orchestrator session', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  let audioPreprocess: ReturnType<typeof fakeAudioPreprocess> | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    // Closing a client socket doesn't guarantee the server's own WS 'close' handler
    // (index.ts -> relay.close() -> audioPreprocess.teardown()) has already run -- that's
    // a separate, asynchronous callback. Without waiting for it here, on a slower/busier
    // CI runner it can fire late enough to land after app.close() has already torn things
    // down, surfacing as an unrelated unhandled-rejection failure (confirmed: this exact
    // race hit CI while passing locally, same category as wsRelay.integration.test.ts's
    // own afterEach comment). One teardown call is expected per socket opened in a test.
    if (audioPreprocess && sockets.length > 0) {
      const expectedCalls = sockets.length;
      await vi
        .waitFor(() => expect(audioPreprocess!.teardown).toHaveBeenCalledTimes(expectedCalls), { timeout: 2000 })
        .catch(() => {});
    }
    sockets.length = 0;
    await app?.close();
  });

  async function serverPort(): Promise<number> {
    await app!.listen({ port: 0 });
    const address = app!.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no server address');
    return address.port;
  }

  it('a valid resume reattaches to the same orchestrator session -- createSession only called once total', async () => {
    audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    orchestrator.resumeSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1', resumeToken: 'tok-2' });
    app = buildServer({ audioPreprocess, orchestrator });
    const port = await serverPort();

    const ticket1 = await mintTicket(app);
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [`vita-ticket.${ticket1}`]);
    sockets.push(ws1);
    const ready1 = await waitForSessionReady(ws1);
    expect(ready1.resumed).toBe(false);
    ws1.close();
    await vi.waitFor(() => expect(audioPreprocess.teardown).toHaveBeenCalled(), { timeout: 2000 });

    const ticket2 = await mintTicket(app, { resumeSessionId: ready1.sessionId, resumeToken: ready1.resumeToken });
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [`vita-ticket.${ticket2}`]);
    sockets.push(ws2);
    const ready2 = await waitForSessionReady(ws2);

    expect(orchestrator.resumeSession).toHaveBeenCalledWith(ready1.sessionId, ready1.resumeToken, 'user-1');
    expect(orchestrator.createSession).toHaveBeenCalledTimes(1); // never a second fresh session
    expect(ready2.resumed).toBe(true);
    expect(ready2.sessionId).toBe(ready1.sessionId);
  });

  it('an invalid/rejected resume falls back to a fresh session -- the call still completes end to end', async () => {
    audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator(); // resumeSession defaults to resolving null
    app = buildServer({ audioPreprocess, orchestrator });
    const port = await serverPort();

    const ticket = await mintTicket(app, { resumeSessionId: 'sess-does-not-exist', resumeToken: 'garbage' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [`vita-ticket.${ticket}`]);
    sockets.push(ws);
    const ready = await waitForSessionReady(ws);

    expect(orchestrator.resumeSession).toHaveBeenCalledWith('sess-does-not-exist', 'garbage', 'user-1');
    expect(orchestrator.createSession).toHaveBeenCalledTimes(1); // fallback fired, call still completed
    expect(ready.resumed).toBe(false);
    expect(ready.sessionId).toBe('sess-1');
  });

  it('a resume evicts a still-open connection for the same session on this process, without the client closing it first', async () => {
    audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    orchestrator.resumeSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1', resumeToken: 'tok-2' });
    app = buildServer({ audioPreprocess, orchestrator });
    const port = await serverPort();

    const ticketA = await mintTicket(app);
    const wsA = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [`vita-ticket.${ticketA}`]);
    sockets.push(wsA);
    const readyA = await waitForSessionReady(wsA);
    // Deliberately NOT closing wsA client-side here -- the server-side eviction must
    // force it closed on its own when connection B resumes the same session.

    const ticketB = await mintTicket(app, { resumeSessionId: readyA.sessionId, resumeToken: readyA.resumeToken });
    const wsB = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [`vita-ticket.${ticketB}`]);
    sockets.push(wsB);
    await waitForSessionReady(wsB);

    // Connection A is evicted and torn down when B resumes the same session. The teardown
    // key is now per-connection (see relay.ts's _connectionId), which this test can't name
    // from out here -- but the stronger property is directly assertable: exactly ONE
    // teardown fired (A's, not B's), and it was NOT keyed on the shared sessionId. Keying
    // on sessionId is precisely the bug this fixed: it would have destroyed B's own live
    // VAD/denoiser state at the moment B took over.
    await vi.waitFor(() => expect(audioPreprocess.teardown).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(audioPreprocess.teardown).not.toHaveBeenCalledWith(readyA.sessionId);
  });
});
