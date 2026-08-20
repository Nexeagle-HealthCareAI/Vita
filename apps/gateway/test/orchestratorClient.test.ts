import { describe, expect, it, vi } from 'vitest';
import { OrchestratorClient } from '../src/orchestratorClient.js';

function fakeFetch(response: { ok: boolean; body?: unknown } | (() => never)) {
  if (typeof response === 'function') {
    return vi.fn(response) as unknown as typeof fetch;
  }
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    json: () => Promise.resolve(response.body),
  }) as unknown as typeof fetch;
}

describe('OrchestratorClient', () => {
  describe('createSession', () => {
    it('happy path returns sessionId + resumeToken from the response body', async () => {
      const fetchImpl = fakeFetch({ ok: true, body: { sessionId: 'sess-1', resumeToken: 'tok-1', userId: 'user-1' } });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      const result = await client.createSession({
        sessionId: 'sess-1',
        userId: 'user-1',
        consentGiven: true,
      });

      expect(result).toEqual({ sessionId: 'sess-1', resumeToken: 'tok-1' });
    });

    it('a non-ok response resolves null', async () => {
      const fetchImpl = fakeFetch({ ok: false });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      expect(
        await client.createSession({ sessionId: 'sess-1', userId: 'user-1', consentGiven: true }),
      ).toBeNull();
    });

    it('includes hospitalId/hmsAccessToken in the POSTed JSON when present (real-staff-JWT forwarding)', async () => {
      const fetchImpl = fakeFetch({ ok: true, body: { sessionId: 'sess-1', resumeToken: 'tok-1', userId: 'user-1' } });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      await client.createSession({
        sessionId: 'sess-1',
        userId: 'user-1',
        consentGiven: true,
        hospitalId: 'h-1',
        hmsAccessToken: 'real-staff-jwt',
      });

      const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({
        sessionId: 'sess-1',
        userId: 'user-1',
        consentGiven: true,
        hospitalId: 'h-1',
        hmsAccessToken: 'real-staff-jwt',
      });
    });
  });

  describe('resumeSession', () => {
    it('happy path posts the right URL + JSON body and returns the rotated credentials', async () => {
      const fetchImpl = fakeFetch({ ok: true, body: { sessionId: 'sess-1', resumeToken: 'new-tok' } });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      const result = await client.resumeSession('sess-1', 'old-tok', 'user-1');

      expect(result).toEqual({ sessionId: 'sess-1', resumeToken: 'new-tok' });
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://orchestrator/session/sess-1/resume',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resumeToken: 'old-tok', userId: 'user-1' }),
        }),
      );
    });

    it('a non-ok response (e.g. 404) resolves null, not a rejection', async () => {
      const fetchImpl = fakeFetch({ ok: false });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      expect(await client.resumeSession('sess-1', 'bad-tok', 'user-1')).toBeNull();
    });

    it('a thrown fetch error (e.g. network failure) also resolves null, not a rejection', async () => {
      const fetchImpl = fakeFetch(() => {
        throw new Error('network down');
      });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      await expect(client.resumeSession('sess-1', 'tok', 'user-1')).resolves.toBeNull();
    });
  });
});
