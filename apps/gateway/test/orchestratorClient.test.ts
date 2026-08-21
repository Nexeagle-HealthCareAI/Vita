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

      // epoch defaults to 0 when the response omits it -- an orchestrator build predating
      // the field must not break this client.
      expect(result).toEqual({ sessionId: 'sess-1', resumeToken: 'tok-1', epoch: 0 });
    });

    it('carries the epoch through when the orchestrator sends one', async () => {
      const fetchImpl = fakeFetch({ ok: true, body: { sessionId: 'sess-1', resumeToken: 'tok-1', epoch: 3 } });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      const result = await client.createSession({ sessionId: 'sess-1', userId: 'user-1', consentGiven: true });

      expect(result?.epoch).toBe(3);
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

      expect(result).toEqual({ sessionId: 'sess-1', resumeToken: 'new-tok', epoch: 0 });
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

  describe('postAudioTurn', () => {
    it('declares the session epoch as a header -- the body is raw PCM, so it can\'t ride there', async () => {
      const fetchImpl = fakeFetch({ ok: true, body: { transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [] } });
      const client = new OrchestratorClient('http://orchestrator', fetchImpl);

      await client.postAudioTurn('sess-1', 7, new Uint8Array([1, 2, 3]));

      const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({ 'x-vita-session-epoch': '7' });
    });
  });
});
