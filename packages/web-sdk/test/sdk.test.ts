import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@vita/protocol';
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
    await sdk.startSession(true);

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

    await sdk.startSession(true);
    sdk.stopSession();
    sdk.stopSession(); // second call must be a no-op, not throw or double-fire IDLE

    const idleCalls = onStateChange.mock.calls.filter(([s]) => s === 'IDLE');
    expect(idleCalls.length).toBe(1);
  });

  it('startSession(false) never fetches a ticket -- blocks with a non-recoverable CONSENT_REQUIRED error instead', async () => {
    const onError = vi.fn();
    global.fetch = vi.fn();
    const sdk = new TeraWebSDK({ ...baseConfig, onError });

    await sdk.startSession(false);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONSENT_REQUIRED', recoverable: false }));
  });

  it('stopSession() during an in-flight fetchTicket() prevents the stale startSession() from connecting (and re-opening the mic) once the fetch resolves', async () => {
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<{ ticket: string }> }) => void;
    global.fetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const sdk = new TeraWebSDK(baseConfig);

    const startPromise = sdk.startSession(true);
    sdk.stopSession(); // fires while the ticket fetch is still pending

    resolveFetch({ ok: true, json: () => Promise.resolve({ ticket: 'tic-1' }) });
    await startPromise;

    // The stale startSession() call must never open a socket once it's been superseded
    // by an explicit stop -- that's what would otherwise silently re-open the mic.
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('stopSession() aborts an in-flight ticket fetch via AbortSignal', async () => {
    let capturedSignal: AbortSignal | undefined;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise(() => {}); // never resolves -- only the signal matters here
    });
    const sdk = new TeraWebSDK(baseConfig);

    void sdk.startSession(true);
    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);

    sdk.stopSession();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('a stale WS connection opened before stopSession() never sends HELLO if onopen fires after the stop', async () => {
    global.fetch = fetchOkWithTicket();
    const sdk = new TeraWebSDK(baseConfig);

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    sdk.stopSession();
    await ws.onopen?.();

    expect(ws.send).not.toHaveBeenCalled();
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

    await sdk.startSession(true);

    expect(lastFetchBody()).toEqual({ consentGiven: true });
  });

  it('a SESSION_READY message stores resumeSessionId/resumeToken, and the next fetchTicket() call includes them', async () => {
    global.fetch = fetchOkWithTicket();
    const sdk = new TeraWebSDK(baseConfig);

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1', resumed: false }) });

    // Simulate an unexpected drop (not a user-initiated stop) -- the SDK's existing
    // transport reconnect (exponential backoff) should fire startSession() again.
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);

    expect(lastFetchBody()).toEqual({ resumeSessionId: 'sess-1', resumeToken: 'tok-1', consentGiven: true });
  });

  it('stopSession() clears resume credentials -- a subsequent startSession() sends none', async () => {
    global.fetch = fetchOkWithTicket();
    const sdk = new TeraWebSDK(baseConfig);

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1', resumed: false }) });

    sdk.stopSession();
    await sdk.startSession(true);

    expect(lastFetchBody()).toEqual({ consentGiven: true });
  });

  it('onSessionResumed fires with the resumed flag from SESSION_READY', async () => {
    global.fetch = fetchOkWithTicket();
    const onSessionResumed = vi.fn();
    const sdk = new TeraWebSDK({ ...baseConfig, onSessionResumed });

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'tok-1', resumed: true }) });

    expect(onSessionResumed).toHaveBeenCalledWith(true);
  });
});

describe('TeraWebSDK — REPLY_TEXT (the assistant reply, as text)', () => {
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

  it('a REPLY_TEXT message with no final field calls onReplyText with isFinal defaulted to true', async () => {
    global.fetch = fetchOkWithTicket();
    const onReplyText = vi.fn();
    const sdk = new TeraWebSDK({ ...baseConfig, onReplyText });

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'REPLY_TEXT', text: 'Dr. Patel is in from 9 to 1.' }) });

    expect(onReplyText).toHaveBeenCalledWith('Dr. Patel is in from 9 to 1.', true);
  });

  it('a REPLY_TEXT message with final:false calls onReplyText with isFinal:false', async () => {
    global.fetch = fetchOkWithTicket();
    const onReplyText = vi.fn();
    const sdk = new TeraWebSDK({ ...baseConfig, onReplyText });

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ event: 'REPLY_TEXT', text: 'Let me check that.', final: false }) });

    expect(onReplyText).toHaveBeenCalledWith('Let me check that.', false);
  });
});

describe('TeraWebSDK — protocol-version HELLO / code 4003 handling', () => {
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

  it('sends HELLO with the current PROTOCOL_VERSION as the first thing on open, before mic-permission-dependent audio capture', async () => {
    global.fetch = fetchOkWithTicket();
    const sdk = new TeraWebSDK(baseConfig);

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    await ws.onopen?.();

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ event: 'HELLO', version: PROTOCOL_VERSION, role: 'ROLE_RECEPTIONIST' }));
  });

  it('a close with code 4003 emits a non-recoverable UNSUPPORTED_PROTOCOL_VERSION error and never reconnects', async () => {
    global.fetch = fetchOkWithTicket();
    const onError = vi.fn();
    const sdk = new TeraWebSDK({ ...baseConfig, onError });

    await sdk.startSession(true);
    const ws = FakeWebSocket.instances[0];
    ws.onclose?.({ code: 4003 });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNSUPPORTED_PROTOCOL_VERSION', recoverable: false }));

    // No reconnect loop -- retrying with the same client build would deterministically
    // fail again. Confirm no new WebSocket is constructed even after the full backoff
    // window (MAX_RECONNECT_DELAY_MS=15s in index.ts) elapses.
    const instancesAtClose = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances.length).toBe(instancesAtClose);
  });
});
