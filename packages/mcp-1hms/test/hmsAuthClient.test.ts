import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HmsAuthClient } from '../src/hmsAuthClient.js';

// easyHMSAPI's UserLoginHandler returns Success:false inside a normal 200 OK (never a 401)
// for a bad password/locked account -- mirror that exactly so these tests exercise the real
// `!data.success` branch in HmsAuthClient.login(), not the `!res.ok` HTTP-failure branch.
function loginResponse(success: boolean, accessToken: string | null, message = 'ok') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success, message, userId: success ? 'u-1' : null, accessToken }),
    text: async () => JSON.stringify({ message }),
  };
}

describe('HmsAuthClient', () => {
  let client: HmsAuthClient | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    client?.stop();
    client = undefined;
    vi.useRealTimers();
  });

  it('logs in once at construction and caches the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(loginResponse(true, 'token-1'));
    client = new HmsAuthClient('https://hms.internal', { login: 'vita@h1', password: 'pw' }, 86_400_000, fetchImpl);

    const token = await client.getToken();

    expect(token).toBe('token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hms.internal/auth/user/login');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ emailOrPhone: 'vita@h1', password: 'pw', isLoginWithOtp: false });

    // A second getToken() reads the cache -- no second fetch.
    await client.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('concurrent getToken() calls during the initial in-flight login share one promise, not duplicate logins', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(loginResponse(true, 'token-1'));
    client = new HmsAuthClient('https://hms.internal', { login: 'vita@h1', password: 'pw' }, 86_400_000, fetchImpl);

    const [a, b, c] = await Promise.all([client.getToken(), client.getToken(), client.getToken()]);

    expect([a, b, c]).toEqual(['token-1', 'token-1', 'token-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a scheduled refresh replaces the cached token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(loginResponse(true, 'token-1'))
      .mockResolvedValueOnce(loginResponse(true, 'token-2'));
    client = new HmsAuthClient('https://hms.internal', { login: 'vita@h1', password: 'pw' }, 1000, fetchImpl);

    expect(await client.getToken()).toBe('token-1');

    await vi.advanceTimersByTimeAsync(1000);

    expect(await client.getToken()).toBe('token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a failed scheduled refresh keeps serving the old cached token and logs the structured failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(loginResponse(true, 'token-1'))
      .mockResolvedValueOnce(loginResponse(false, null, 'password changed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    client = new HmsAuthClient('https://hms.internal', { login: 'vita@h1', password: 'pw' }, 1000, fetchImpl);

    expect(await client.getToken()).toBe('token-1');

    await vi.advanceTimersByTimeAsync(1000);

    expect(await client.getToken()).toBe('token-1'); // still the old token, not thrown
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('VITA_HMS_STAFF_TOKEN_REFRESH_FAILED'),
    );
    errorSpy.mockRestore();
  });

  it('getToken() rejects if the very first login fails (no cached token ever established)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(loginResponse(false, null, 'bad credentials'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    client = new HmsAuthClient('https://hms.internal', { login: 'vita@h1', password: 'wrong' }, 86_400_000, fetchImpl);

    await expect(client.getToken()).rejects.toThrow(/bad credentials/);
    errorSpy.mockRestore();
  });

  it('forceRefresh() performs a fresh login and updates the cache, independent of the timer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(loginResponse(true, 'token-1'))
      .mockResolvedValueOnce(loginResponse(true, 'token-2'));
    client = new HmsAuthClient('https://hms.internal', { login: 'vita@h1', password: 'pw' }, 86_400_000, fetchImpl);

    expect(await client.getToken()).toBe('token-1');

    const refreshed = await client.forceRefresh();

    expect(refreshed).toBe('token-2');
    expect(await client.getToken()).toBe('token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
