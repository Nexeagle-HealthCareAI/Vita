import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeraWebSDK } from '../src/index.js';

/** Minimal fake standing in for the browser WebSocket -- only the surface TeraWebSDK
 * actually touches (onopen/onmessage/onerror/onclose, send, close, binaryType). Tests
 * drive it manually (calling e.g. instance.onmessage?.(...)) rather than simulating a
 * real connection, since jsdom/node have no real WS server to connect to here. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
}

function fetchOkWithTicket(ticket = 'tic-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket }) });
}

function lastFetchBody(): unknown {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return JSON.parse(calls[calls.length - 1][1].body as string);
}

describe('TeraWebSDK — ticket fetch & error handling', () => {
  const baseConfig = {
    gatewayOrigin: 'https://gateway.vita.hospital',
    authToken: 'test-jwt',
    userRole: 'ROLE_RECEPTIONIST' as const,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    // @ts-expect-error -- test double, not a spec-complete WebSocket
    global.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('surfaces a recoverable error and schedules a retry when ticket exchange fails', async () => {
    const onError = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const sdk = new TeraWebSDK({ ...baseConfig, onError });
    await sdk.startSession();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TICKET_FETCH_FAILED', recoverable: true }),
    );
    // never attempted a real JWT-in-URL connection — auth stayed on the HTTPS leg
    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.vita.hospital/session/ticket',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-jwt' }),
      }),
    );
  });

  it('stopSession() is idempotent — safe to call twice without double side effects', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const onStateChange = vi.fn();
    const sdk = new TeraWebSDK({ ...baseConfig, onStateChange });

    await sdk.startSession();
    sdk.stopSession();
    sdk.stopSession(); // second call must be a no-op, not throw or double-fire IDLE

    const idleCalls = onStateChange.mock.calls.filter(([s]) => s === 'IDLE');
    expect(idleCalls.length).toBe(1);
  });
});

describe('TeraWebSDK — SESSION_RESUME (resume credentials across a reconnect)', () => {
  const baseConfig = {
    gatewayOrigin: 'https://gateway.vita.hospital',
    authToken: 'test-jwt',
    userRole: 'ROLE_RECEPTIONIST' as const,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    // @ts-expect-error -- test double, not a spec-complete WebSocket
    global.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fetchTicket() sends no resumeSessionId/resumeToken on a fresh session', async () => {
    global.fetch = fetchOkWithTicket();
    const sdk = new TeraWebSDK(baseConfig);

    await sdk.startSession();

    expect(lastFetchBody()).toEqual({});
  });

  it('a SESSION_READY message stores resumeSessionId/resumeToken, and the next fetchTicket() call includes them', async () => {
    global.fetch = fetchOkWithTicket();
    const sdk = new TeraWebSDK(baseConfig);

    await sdk.startSession();
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1', resumed: false }) });

    // Simulate an unexpected drop (not a user-initiated stop) -- the SDK's existing
    // transport reconnect (exponential backoff) should fire startSession() again.
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);

    expect(lastFetchBody()).toEqual({ resumeSessionId: 'sess-1', resumeToken: 'tok-1' });
  });

  it('stopSession() clears resume credentials -- a subsequent startSession() sends none', async () => {
    global.fetch = fetchOkWithTicket();
    const sdk = new TeraWebSDK(baseConfig);

    await sdk.startSession();
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1', resumed: false }) });

    sdk.stopSession();
    await sdk.startSession();

    expect(lastFetchBody()).toEqual({});
  });

  it('onSessionResumed fires with the resumed flag from SESSION_READY', async () => {
    global.fetch = fetchOkWithTicket();
    const onSessionResumed = vi.fn();
    const sdk = new TeraWebSDK({ ...baseConfig, onSessionResumed });

    await sdk.startSession();
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1', resumed: true }) });

    expect(onSessionResumed).toHaveBeenCalledWith(true);
  });
});
