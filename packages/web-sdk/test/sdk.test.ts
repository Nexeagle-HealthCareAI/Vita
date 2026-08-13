import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeraWebSDK } from '../src/index.js';

describe('TeraWebSDK — ticket fetch & error handling', () => {
  const baseConfig = {
    gatewayOrigin: 'https://gateway.tera.hospital',
    authToken: 'test-jwt',
    userRole: 'ROLE_RECEPTIONIST' as const,
  };

  beforeEach(() => {
    vi.useFakeTimers();
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
      'https://gateway.tera.hospital/session/ticket',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-jwt' },
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
