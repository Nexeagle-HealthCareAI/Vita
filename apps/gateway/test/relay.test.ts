import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPreprocessClient } from '../src/audioPreprocessClient.js';
import { OrchestratorClient, type TurnAudioResponse } from '../src/orchestratorClient.js';
import { ConnectionRelay, type RelayConfig } from '../src/relay.js';
import type { SessionClaims } from '../src/ticket.js';

const CLAIMS: SessionClaims = { sub: 'user-1', role: 'ROLE_RECEPTIONIST' };

function fakeAudioPreprocess() {
  const client = Object.create(AudioPreprocessClient.prototype) as AudioPreprocessClient;
  client.process = vi.fn();
  return client;
}

function fakeOrchestrator(turnResult?: TurnAudioResponse) {
  const client = Object.create(OrchestratorClient.prototype) as OrchestratorClient;
  client.createSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
  client.postAudioTurn = vi.fn().mockResolvedValue(
    turnResult ?? { ok: true, data: { transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [] } },
  );
  return client;
}

function frame(marker: number) {
  return new Uint8Array([marker]);
}

/** Queues one frame and flushes microtasks so the relay's internal frameQueue -- and any
 * detached end-of-utterance chain it kicked off (startEndOfUtterance() deliberately doesn't
 * await endOfUtterance(), see relay.ts) -- has fully settled before assertions run. A single
 * advanceTimersByTimeAsync(0) isn't guaranteed to drain a multi-hop detached chain, so loop. */
async function sendFrame(relay: ConnectionRelay, data: Uint8Array) {
  relay.handleAudioFrame(data);
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function jsonSends(sent: (string | Uint8Array)[]): unknown[] {
  return sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
}

describe('ConnectionRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sustained speech + hangover ends the utterance with pre-roll-inclusive, correctly ordered audio', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const sent: (string | Uint8Array)[] = [];
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 40, silenceHangoverMs: 40, preRollFrames: 2 },
    );
    await relay.start();

    (audioPreprocess.process as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ frame: frame(10), speechDetected: false }) // P1 -> preRoll
      .mockResolvedValueOnce({ frame: frame(11), speechDetected: false }) // P2 -> preRoll
      .mockResolvedValueOnce({ frame: frame(20), speechDetected: true }) // S1 -> starts utterance
      .mockResolvedValueOnce({ frame: frame(21), speechDetected: true }) // S2 -> arms (40ms)
      .mockResolvedValueOnce({ frame: frame(30), speechDetected: false }) // N1
      .mockResolvedValueOnce({ frame: frame(31), speechDetected: false }); // N2 -> hangover (40ms) fires

    for (const marker of [1, 2, 3, 4, 5, 6]) {
      await sendFrame(relay, frame(marker));
    }

    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1);
    const [sessionId, audio] = (orchestrator.postAudioTurn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(Array.from(audio as Uint8Array)).toEqual([10, 11, 20, 21, 30, 31]);

    const events = jsonSends(sent);
    expect(events[0]).toEqual({ event: 'STATE_CHANGE', state: 'PROCESSING' });
  });

  it('a sub-threshold speech blip never arms, so silence afterward never ends an utterance', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: () => {} },
      { minUtteranceSpeechMs: 40, silenceHangoverMs: 40 },
    );
    await relay.start();

    (audioPreprocess.process as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ frame: frame(1), speechDetected: true }) // 20ms speech, below 40ms threshold
      .mockResolvedValueOnce({ frame: frame(2), speechDetected: false })
      .mockResolvedValueOnce({ frame: frame(3), speechDetected: false })
      .mockResolvedValueOnce({ frame: frame(4), speechDetected: false });

    for (const marker of [1, 2, 3, 4]) {
      await sendFrame(relay, frame(marker));
    }

    expect(orchestrator.postAudioTurn).not.toHaveBeenCalled();
  });

  it('maxUtteranceMs force-flushes a stuck buffer even while unarmed, then starts a fresh utterance', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: () => {} },
      { minUtteranceSpeechMs: 10_000, maxUtteranceMs: 60 }, // never arms via the normal path
    );
    await relay.start();

    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    await sendFrame(relay, frame(1));
    await sendFrame(relay, frame(2));
    await sendFrame(relay, frame(3)); // 3 * 20ms = 60ms >= maxUtteranceMs

    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1);

    // A fresh utterance should be accumulating from scratch afterward.
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(9), speechDetected: false });
    await sendFrame(relay, frame(9));
    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1); // still just the one force-flush
  });

  it('a successful turn: exact event order, and STATE_CHANGE:LISTENING waits for the computed playback duration', async () => {
    const audio = new Uint8Array(3200); // 100ms of 16-bit mono PCM16 @16kHz
    const orchestrator = fakeOrchestrator({
      ok: true,
      data: { transcript: 'hello', replyText: 'hi there', audioBase64: Buffer.from(audio).toString('base64'), toolCallsExecuted: [] },
    });
    const audioPreprocess = fakeAudioPreprocess();
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    const sent: (string | Uint8Array)[] = [];
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, silenceHangoverMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(2), speechDetected: false });
    await sendFrame(relay, frame(2)); // 20ms silence -> hangover -> ends utterance

    const events = jsonSends(sent);
    expect(events).toEqual([
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'TRANSCRIPT', text: 'hello', is_final: true },
      { event: 'STATE_CHANGE', state: 'SPEAKING' },
    ]);
    const binaryFrames = sent.filter((s): s is Uint8Array => s instanceof Uint8Array);
    expect(binaryFrames.length).toBeGreaterThan(0);

    // 100ms of audio -> SPEAKING must hold for ~100ms, not just the send-loop duration.
    await vi.advanceTimersByTimeAsync(99);
    expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'SPEAKING' });

    await vi.advanceTimersByTimeAsync(5);
    expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'LISTENING' });
  });

  it('an empty/whitespace transcript is a soft no-op: no TRANSCRIPT, no audio, straight back to LISTENING', async () => {
    const orchestrator = fakeOrchestrator({
      ok: true,
      data: { transcript: '   ', replyText: null, audioBase64: null, toolCallsExecuted: [] },
    });
    const audioPreprocess = fakeAudioPreprocess();
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    const sent: (string | Uint8Array)[] = [];
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms (first frame of a new utterance always just starts accumulating)
    await sendFrame(relay, frame(2)); // 40ms accumulated >= maxUtteranceMs=20 -> force-flushed

    expect(jsonSends(sent)).toEqual([
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'STATE_CHANGE', state: 'LISTENING' },
    ]);
    expect(sent.some((s) => s instanceof Uint8Array)).toBe(false);
  });

  it('a recoverable orchestrator error sends ERROR + back to LISTENING, and a later utterance still works', async () => {
    const orchestrator = fakeOrchestrator({ ok: false, error: { code: 'STT_FAILED', message: 'boom', recoverable: true } });
    const audioPreprocess = fakeAudioPreprocess();
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    const sent: (string | Uint8Array)[] = [];
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    await sendFrame(relay, frame(2)); // force-flushes -> the (failing) turn

    expect(jsonSends(sent)).toEqual([
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'ERROR', code: 'STT_FAILED', message: 'boom', recoverable: true },
      { event: 'STATE_CHANGE', state: 'LISTENING' },
    ]);

    (orchestrator.postAudioTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [] },
    });
    await sendFrame(relay, frame(3)); // arms a second utterance
    await sendFrame(relay, frame(4)); // force-flushes it -> second postAudioTurn call
    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(2);
  });

  it('a non-recoverable orchestrator error sends ERROR + STATE_CHANGE:ERROR and stops relaying entirely', async () => {
    const orchestrator = fakeOrchestrator({ ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'gone', recoverable: false } });
    const audioPreprocess = fakeAudioPreprocess();
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    const sent: (string | Uint8Array)[] = [];
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    await sendFrame(relay, frame(2)); // force-flushes -> the (failing) turn

    expect(jsonSends(sent)).toEqual([
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'ERROR', code: 'SESSION_NOT_FOUND', message: 'gone', recoverable: false },
      { event: 'STATE_CHANGE', state: 'ERROR' },
    ]);

    const callsBefore = (audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length;
    await sendFrame(relay, frame(3));
    expect((audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1);
  });

  it('frames arriving during PROCESSING are dropped, not queued -- no audioPreprocess/orchestrator calls for them', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    let resolveTurn!: (v: TurnAudioResponse) => void;
    const orchestrator = fakeOrchestrator();
    orchestrator.postAudioTurn = vi.fn().mockReturnValue(new Promise((resolve) => (resolveTurn = resolve)));

    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, claims: CLAIMS, send: () => {} },
      { minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    await sendFrame(relay, frame(2)); // force-flushes -> PROCESSING, postAudioTurn now pending (unresolved)
    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1);

    const preprocessCallsAtProcessing = (audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length;
    await sendFrame(relay, frame(3)); // arrives while still PROCESSING -- must be dropped promptly, not queued
    expect((audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length).toBe(preprocessCallsAtProcessing);

    resolveTurn({ ok: true, data: { transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(1); // frame(3) never triggered a second turn
  });

  describe('barge-in', () => {
    const CONFIG: Partial<RelayConfig> = { minUtteranceSpeechMs: 40, silenceHangoverMs: 20, bargeInGraceMs: 40 };

    async function getIntoSpeaking(sent: (string | Uint8Array)[], audioPreprocess: AudioPreprocessClient) {
      const audio = new Uint8Array(32_000); // 1000ms of audio -- long enough to test barge-in mid-playback
      const orchestrator = fakeOrchestrator({
        ok: true,
        data: { transcript: 'hi', replyText: 'hello', audioBase64: Buffer.from(audio).toString('base64'), toolCallsExecuted: [] },
      });
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, claims: CLAIMS, send: (d) => sent.push(d) }, CONFIG);
      await relay.start();

      (audioPreprocess.process as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ frame: frame(1), speechDetected: true })
        .mockResolvedValueOnce({ frame: frame(2), speechDetected: true }); // arms (40ms)
      await sendFrame(relay, frame(1));
      await sendFrame(relay, frame(2));
      (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(3), speechDetected: false });
      await sendFrame(relay, frame(3)); // 20ms silence -> hangover -> ends utterance -> speak()

      return { relay, orchestrator };
    }

    it('suppresses barge-in detection during the grace window (no audioPreprocess calls at all)', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const sent: (string | Uint8Array)[] = [];
      await getIntoSpeaking(sent, audioPreprocess);

      const callsAtSpeakingStart = (audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(10); // well within bargeInGraceMs=40
      expect((audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtSpeakingStart);
    });

    it('a single post-grace blip does not trigger barge-in; sustained post-grace speech does', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const sent: (string | Uint8Array)[] = [];
      const { relay, orchestrator } = await getIntoSpeaking(sent, audioPreprocess);

      await vi.advanceTimersByTimeAsync(41); // past bargeInGraceMs=40 -> armed

      (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(50), speechDetected: true });
      await sendFrame(relay, frame(50)); // 20ms -- below minUtteranceSpeechMs=40
      expect(jsonSends(sent).some((e) => (e as { event: string }).event === 'CLEAR_PLAYBACK')).toBe(false);

      (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(51), speechDetected: true });
      await sendFrame(relay, frame(51)); // cumulative 40ms -> triggers

      const events = jsonSends(sent);
      const clearIdx = events.findIndex((e) => (e as { event: string }).event === 'CLEAR_PLAYBACK');
      expect(clearIdx).toBeGreaterThan(-1);
      expect(events[clearIdx]).toEqual({ event: 'CLEAR_PLAYBACK', reason: 'USER_BARGE_IN' });
      expect(events[clearIdx + 1]).toEqual({ event: 'STATE_CHANGE', state: 'LISTENING' });

      // A fresh utterance accumulates normally afterward.
      (audioPreprocess.process as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ frame: frame(60), speechDetected: true })
        .mockResolvedValueOnce({ frame: frame(61), speechDetected: true })
        .mockResolvedValueOnce({ frame: frame(62), speechDetected: false });
      await sendFrame(relay, frame(60));
      await sendFrame(relay, frame(61));
      await sendFrame(relay, frame(62));
      expect(orchestrator.postAudioTurn).toHaveBeenCalledTimes(2); // the original turn + this new one
    });

    it('BARGE_IN_ENABLED=false skips audioPreprocess calls entirely while SPEAKING', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const audio = new Uint8Array(32_000);
      const orchestrator = fakeOrchestrator({
        ok: true,
        data: { transcript: 'hi', replyText: 'hello', audioBase64: Buffer.from(audio).toString('base64'), toolCallsExecuted: [] },
      });
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay(
        { audioPreprocess, orchestrator, claims: CLAIMS, send: (d) => sent.push(d) },
        { ...CONFIG, bargeInEnabled: false },
      );
      await relay.start();

      (audioPreprocess.process as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ frame: frame(1), speechDetected: true })
        .mockResolvedValueOnce({ frame: frame(2), speechDetected: true });
      await sendFrame(relay, frame(1));
      await sendFrame(relay, frame(2));
      (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(3), speechDetected: false });
      await sendFrame(relay, frame(3));

      const callsAtSpeaking = (audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      await sendFrame(relay, frame(99));
      expect((audioPreprocess.process as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtSpeaking);
    });
  });
});
