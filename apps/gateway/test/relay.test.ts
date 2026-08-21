import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PROTOCOL_VERSION } from '@vita/protocol';
import { AudioPreprocessClient } from '../src/audioPreprocessClient.js';
import { OrchestratorClient, type TurnAudioResponse } from '../src/orchestratorClient.js';
import { ConnectionRelay, type RelayConfig } from '../src/relay.js';
import { BatchTurnBackend, type TurnBackend, type TurnBackendEvents, type TurnBackendFactory } from '../src/turnBackend.js';
import type { SessionClaims } from '../src/ticket.js';

const CLAIMS: SessionClaims = { sub: 'user-1' };

function fakeAudioPreprocess() {
  const client = Object.create(AudioPreprocessClient.prototype) as AudioPreprocessClient;
  client.process = vi.fn();
  client.teardown = vi.fn().mockResolvedValue(undefined);
  return client;
}

function fakeOrchestrator(turnResult?: TurnAudioResponse) {
  const client = Object.create(OrchestratorClient.prototype) as OrchestratorClient;
  client.createSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1', resumeToken: 'resume-tok-1' });
  client.resumeSession = vi.fn().mockResolvedValue(null);
  client.postAudioTurn = vi.fn().mockResolvedValue(
    turnResult ?? { ok: true, data: { transcript: '', replyText: null, audioBase64: null, toolCallsExecuted: [], formFields: null } },
  );
  return client;
}

const SESSION_READY = { event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'resume-tok-1', resumed: false };

/** Wires a real BatchTurnBackend (today's exact production fallback behavior, see
 * turnBackend.ts) around whichever fakeOrchestrator() a test constructs, instead of a
 * bespoke test-only double -- so these tests keep exercising the real
 * ConnectionRelay<->TurnBackend integration, not a re-implementation of it. Each created
 * backend's beginUtterance/endUtterance/close are spied so tests can assert on the
 * Strategy-split boundary itself (e.g. "a sub-threshold blip never opens a backend"),
 * not just on the orchestrator calls one layer down. */
function fakeBackendFactory(orchestrator: OrchestratorClient) {
  const backends: TurnBackend[] = [];
  const create = vi.fn((sessionId: string, events: TurnBackendEvents): Promise<TurnBackend> => {
    const backend = new BatchTurnBackend(orchestrator, sessionId, events);
    vi.spyOn(backend, 'beginUtterance');
    vi.spyOn(backend, 'endUtterance');
    vi.spyOn(backend, 'close');
    backends.push(backend);
    return Promise.resolve(backend);
  });
  return { create, backends } satisfies TurnBackendFactory & { create: Mock; backends: TurnBackend[] };
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

/** A fully test-controlled TurnBackend (unlike fakeBackendFactory's real BatchTurnBackend
 * above) -- lets a test fire onReplyAudio() multiple times per turn at will, to exercise
 * the streaming (StreamingTurnBackend-shaped) multi-chunk path through ConnectionRelay
 * without needing a real orchestrator WS connection. abortActiveTurn is spied so tests
 * can assert ConnectionRelay.triggerBargeIn() actually propagates the abort. */
function fakeStreamingBackendFactory() {
  const events: TurnBackendEvents[] = [];
  const abortActiveTurn = vi.fn();
  const beginUtterance = vi.fn();
  const endUtterance = vi.fn();
  const close = vi.fn();
  const create = vi.fn((_sessionId: string, evts: TurnBackendEvents): Promise<TurnBackend> => {
    events.push(evts);
    return Promise.resolve({ beginUtterance, pushFrame: vi.fn(), endUtterance, abortActiveTurn, close });
  });
  return { create, events, abortActiveTurn, beginUtterance, endUtterance, close } satisfies TurnBackendFactory & {
    create: Mock;
    events: TurnBackendEvents[];
    abortActiveTurn: Mock;
    beginUtterance: Mock;
    endUtterance: Mock;
    close: Mock;
  };
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
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
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
    expect(events[0]).toEqual(SESSION_READY);
    expect(events[1]).toEqual({ event: 'STATE_CHANGE', state: 'PROCESSING' });
  });

  it('forwards claims.hospitalId/hmsAccessToken into createSession() when present (real-staff-JWT forwarding)', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const claimsWithStaffAuth: SessionClaims = { ...CLAIMS, hospitalId: 'h-1', hmsAccessToken: 'real-staff-jwt' };
    const relay = new ConnectionRelay({
      audioPreprocess,
      orchestrator,
      backendFactory: fakeBackendFactory(orchestrator),
      claims: claimsWithStaffAuth,
      send: () => {},
    });
    await relay.start();

    expect(orchestrator.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ hospitalId: 'h-1', hmsAccessToken: 'real-staff-jwt' }),
    );
  });

  it('createSession() carries undefined hospitalId/hmsAccessToken when claims never had them (backward compat)', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const relay = new ConnectionRelay({
      audioPreprocess,
      orchestrator,
      backendFactory: fakeBackendFactory(orchestrator),
      claims: CLAIMS,
      send: () => {},
    });
    await relay.start();

    const [input] = (orchestrator.createSession as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.hospitalId).toBeUndefined();
    expect(input.hmsAccessToken).toBeUndefined();
  });

  it('threads this CONNECTION id (not the shared session id) into every audioPreprocess.process call', async () => {
    // Per-connection, deliberately: the VAD/denoiser models' state belongs to one
    // continuous mic stream, not to a dialogue. Keying on sessionId would let two relays
    // for one resumed session interleave into a single shared VAD record, and would let
    // the loser's teardown destroy the winner's live state. See relay.ts's _connectionId.
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {} });
    await relay.start();

    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(1), speechDetected: false });
    await sendFrame(relay, frame(1));

    expect(audioPreprocess.process).toHaveBeenCalledWith(expect.any(Uint8Array), relay.connectionId);
    expect(relay.connectionId).not.toBe('sess-1');
  });

  it('two relays sharing one resumed sessionId get DIFFERENT audio-preprocess keys', async () => {
    // The cross-talk case this keying exists to make structurally impossible.
    const orchestrator = fakeOrchestrator();
    const relayA = new ConnectionRelay({ audioPreprocess: fakeAudioPreprocess(), orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {} });
    const relayB = new ConnectionRelay({ audioPreprocess: fakeAudioPreprocess(), orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {} });
    await relayA.start();
    await relayB.start();

    expect(relayA.sessionId).toBe(relayB.sessionId); // same orchestrator session
    expect(relayA.connectionId).not.toBe(relayB.connectionId); // but isolated audio state
  });

  it('a sub-threshold speech blip never arms, so silence afterward never ends an utterance', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const backendFactory = fakeBackendFactory(orchestrator);
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: () => {} },
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
    // The Strategy-split boundary itself: a sub-threshold blip must never reach
    // TurnBackend.beginUtterance() (which is what would open a real Sarvam connection in
    // StreamingTurnBackend) -- start() still calls create() once per call regardless.
    expect(backendFactory.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(backendFactory.backends[0].beginUtterance)).not.toHaveBeenCalled();
  });

  it('maxUtteranceMs force-flushes a stuck buffer even while unarmed, then starts a fresh utterance', async () => {
    const audioPreprocess = fakeAudioPreprocess();
    const orchestrator = fakeOrchestrator();
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {} },
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
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, silenceHangoverMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(2), speechDetected: false });
    await sendFrame(relay, frame(2)); // 20ms silence -> hangover -> ends utterance

    const events = jsonSends(sent);
    expect(events).toEqual([
      SESSION_READY,
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'TRANSCRIPT', text: 'hello', is_final: true },
      { event: 'REPLY_TEXT', text: 'hi there' },
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

  it('a turn with new slot values sends UI_FORM_AUTOFILL for a ROLE_RECEPTIONIST session', async () => {
    const audio = new Uint8Array(3200);
    const orchestrator = fakeOrchestrator({
      ok: true,
      data: {
        transcript: 'book Riya Sharma',
        replyText: 'Booked.',
        audioBase64: Buffer.from(audio).toString('base64'),
        toolCallsExecuted: ['book_appointment'],
        formFields: { patientName: 'Riya Sharma', patientMobile: '9999999999' },
      },
    });
    const audioPreprocess = fakeAudioPreprocess();
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    const sent: (string | Uint8Array)[] = [];
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, silenceHangoverMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(2), speechDetected: false });
    await sendFrame(relay, frame(2)); // ends utterance

    expect(jsonSends(sent)).toContainEqual({
      event: 'UI_FORM_AUTOFILL',
      data: { patientName: 'Riya Sharma', patientMobile: '9999999999' },
    });
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
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms (first frame of a new utterance always just starts accumulating)
    await sendFrame(relay, frame(2)); // 40ms accumulated >= maxUtteranceMs=20 -> force-flushed

    expect(jsonSends(sent)).toEqual([
      SESSION_READY,
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
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
      { minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    await sendFrame(relay, frame(2)); // force-flushes -> the (failing) turn

    expect(jsonSends(sent)).toEqual([
      SESSION_READY,
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

  it('a non-recoverable orchestrator error sends ERROR + STATE_CHANGE:ERROR, closes the socket (4004, reconnect-eligible), and stops relaying entirely', async () => {
    const orchestrator = fakeOrchestrator({ ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'gone', recoverable: false } });
    const audioPreprocess = fakeAudioPreprocess();
    (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });

    const sent: (string | Uint8Array)[] = [];
    const closeSpy = vi.fn();
    const relay = new ConnectionRelay(
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d), close: closeSpy },
      { minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
    );
    await relay.start();

    await sendFrame(relay, frame(1)); // arms
    await sendFrame(relay, frame(2)); // force-flushes -> the (failing) turn

    expect(jsonSends(sent)).toEqual([
      SESSION_READY,
      { event: 'STATE_CHANGE', state: 'PROCESSING' },
      { event: 'ERROR', code: 'SESSION_NOT_FOUND', message: 'gone', recoverable: false },
      { event: 'STATE_CHANGE', state: 'ERROR' },
    ]);
    // Real socket close, not just internal bookkeeping -- lets the client actually
    // reconnect (web-sdk's onclose retries on any code but 4003) and lets index.ts's own
    // 'close' handler run the real relay.close() teardown (previously this leaked
    // audioPreprocess/backend state indefinitely -- this locks in that leak fix).
    expect(closeSpy).toHaveBeenCalledWith(4004, 'SESSION_NOT_FOUND');
    // sessionId deliberately stays set here -- close() itself (not onBackendError) is what
    // nulls it, and in production that only happens once the socket's real 'close' event
    // fires and index.ts's handler runs relay.close(), same pattern the hello-timeout path
    // below already relies on.
    expect(relay.sessionId).toBe('sess-1');

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
      { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {} },
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
      const relay = new ConnectionRelay(
        { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
        CONFIG,
      );
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
        { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
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

  describe('multi-chunk speak() (streaming replies)', () => {
    const CONFIG: Partial<RelayConfig> = { minUtteranceSpeechMs: 40, silenceHangoverMs: 20, bargeInGraceMs: 40 };

    /** Drives real VAD-detected frames through the relay until an utterance ends and
     * startEndOfUtterance() dispatches it to the backend (PROCESSING) -- same shape as
     * the barge-in describe block's getIntoSpeaking(), but stops at PROCESSING instead
     * of assuming a real backend replies on its own, since these tests drive replies
     * manually via the fake streaming backend's captured events. */
    async function driveUtteranceIntoProcessing(relay: ConnectionRelay, audioPreprocess: AudioPreprocessClient, markers: [number, number, number]) {
      (audioPreprocess.process as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ frame: frame(markers[0]), speechDetected: true })
        .mockResolvedValueOnce({ frame: frame(markers[1]), speechDetected: true }); // arms (40ms)
      await sendFrame(relay, frame(markers[0]));
      await sendFrame(relay, frame(markers[1]));
      (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ frame: frame(markers[2]), speechDetected: false });
      await sendFrame(relay, frame(markers[2])); // 20ms silence -> hangover -> ends utterance -> PROCESSING
    }

    /** durationMs of 16-bit mono PCM16 @16kHz. */
    function pcm16(durationMs: number): Uint8Array {
      return new Uint8Array(Math.round((durationMs / 1000) * 16000 * 2));
    }

    it('a 3-chunk reply produces exactly one STATE_CHANGE:SPEAKING/LISTENING pair, timed off the total duration', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const backendFactory = fakeStreamingBackendFactory();
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: (d) => sent.push(d) }, CONFIG);
      await relay.start();
      await driveUtteranceIntoProcessing(relay, audioPreprocess, [1, 2, 3]);

      const events = backendFactory.events[0]!;
      events.onReplyAudio(pcm16(100), false); // chunk 1
      events.onReplyAudio(pcm16(100), false); // chunk 2
      events.onReplyAudio(pcm16(100), true); // chunk 3 (final) -- 300ms total

      const speakingEvents = jsonSends(sent).filter((e) => JSON.stringify(e) === JSON.stringify({ event: 'STATE_CHANGE', state: 'SPEAKING' }));
      expect(speakingEvents.length).toBe(1); // not once per chunk

      await vi.advanceTimersByTimeAsync(299);
      expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'SPEAKING' });
      await vi.advanceTimersByTimeAsync(5);
      expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'LISTENING' });

      const listeningEvents = jsonSends(sent).filter((e) => JSON.stringify(e) === JSON.stringify({ event: 'STATE_CHANGE', state: 'LISTENING' }));
      expect(listeningEvents.length).toBe(1);
      const binaryFrames = sent.filter((s): s is Uint8Array => s instanceof Uint8Array);
      expect(binaryFrames.length).toBeGreaterThan(0);
    });

    it('onFormAutofill sends UI_FORM_AUTOFILL on the streaming path too', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const backendFactory = fakeStreamingBackendFactory();
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: (d) => sent.push(d) }, CONFIG);
      await relay.start();
      await driveUtteranceIntoProcessing(relay, audioPreprocess, [1, 2, 3]);

      const events = backendFactory.events[0]!;
      events.onFormAutofill?.({ preferredDate: '2026-08-20' });

      expect(jsonSends(sent)).toContainEqual({ event: 'UI_FORM_AUTOFILL', data: { preferredDate: '2026-08-20' } });
    });

    it('a barge-in mid-reply aborts the backend and silently drops the chunk already in flight', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const backendFactory = fakeStreamingBackendFactory();
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: (d) => sent.push(d) }, CONFIG);
      await relay.start();
      await driveUtteranceIntoProcessing(relay, audioPreprocess, [1, 2, 3]);

      const events = backendFactory.events[0]!;
      events.onReplyAudio(pcm16(1000), false); // chunk 1 of a long reply -- still speaking when barge-in fires
      events.onReplyAudio(pcm16(1000), false); // chunk 2

      await vi.advanceTimersByTimeAsync(41); // past bargeInGraceMs=40 -> armed
      (audioPreprocess.process as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ frame: frame(50), speechDetected: true })
        .mockResolvedValueOnce({ frame: frame(51), speechDetected: true });
      await sendFrame(relay, frame(50)); // 20ms -- below minUtteranceSpeechMs=40
      await sendFrame(relay, frame(51)); // cumulative 40ms -> triggers barge-in

      expect(jsonSends(sent).some((e) => (e as { event: string }).event === 'CLEAR_PLAYBACK')).toBe(true);
      expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'LISTENING' });
      expect(backendFactory.abortActiveTurn).toHaveBeenCalledTimes(1);

      // Chunk 3 was already being synthesized server-side when the abort fired -- it
      // arrives anyway, but must be silently dropped: no new frames, no state churn.
      const sentLengthAtBargeIn = sent.length;
      events.onReplyAudio(pcm16(1000), true);
      await vi.advanceTimersByTimeAsync(1001);
      expect(sent.length).toBe(sentLengthAtBargeIn);
    });

    it('a stale chunk from an aborted turn arriving after the NEXT turn has already finished speaking never reopens SPEAKING', async () => {
      // Coverage boundary, matching what relay.ts's speak() doc comment states: the
      // awaitingFirstReplyChunk gate is a backstop for a chunk still in flight when abort
      // fires, closing the gap BEFORE the next turn is dispatched (see the barge-in test
      // above) and the gap AFTER the next turn fully completes (this test). It can't
      // (without real per-chunk turn identity, deliberately out of scope -- see the plan)
      // distinguish a stale chunk from a legitimate one arriving WHILE a newer turn is
      // still actively speaking -- that narrower residual race relies on the orchestrator
      // honoring turn.abort and not producing the stale chunk at all in the first place.
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const backendFactory = fakeStreamingBackendFactory();
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: (d) => sent.push(d) }, CONFIG);
      await relay.start();

      // Turn A: starts speaking, then gets interrupted.
      await driveUtteranceIntoProcessing(relay, audioPreprocess, [1, 2, 3]);
      const events = backendFactory.events[0]!;
      events.onReplyAudio(pcm16(1000), false); // turn A, chunk 1

      await vi.advanceTimersByTimeAsync(41);
      (audioPreprocess.process as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ frame: frame(50), speechDetected: true })
        .mockResolvedValueOnce({ frame: frame(51), speechDetected: true });
      await sendFrame(relay, frame(50));
      await sendFrame(relay, frame(51)); // triggers barge-in -- turn A aborted
      expect(backendFactory.abortActiveTurn).toHaveBeenCalledTimes(1);

      // Turn B: the barge-in's own utterance is captured, dispatched, and fully replies
      // to and completes -- back to LISTENING.
      await driveUtteranceIntoProcessing(relay, audioPreprocess, [60, 61, 62]);
      events.onReplyAudio(pcm16(50), true); // turn B's whole (short) reply
      expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'SPEAKING' });
      await vi.advanceTimersByTimeAsync(51);
      expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'LISTENING' });

      // Turn A's stale final chunk (already in flight when the abort fired) arrives only
      // now, well after turn B finished -- must be dropped, not reopen SPEAKING.
      const sentLengthAfterTurnB = sent.length;
      events.onReplyAudio(pcm16(1000), true);
      expect(sent.length).toBe(sentLengthAfterTurnB);
      expect(jsonSends(sent).at(-1)).toEqual({ event: 'STATE_CHANGE', state: 'LISTENING' });
    });
  });

  describe('close() / audio-preprocess teardown', () => {
    it('calls teardown(connectionId) and backend.close() exactly once when the session was established', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const backendFactory = fakeBackendFactory(orchestrator);
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: () => {} });
      await relay.start();
      const { connectionId } = relay; // capture before close() -- sessionId is nulled, this isn't

      relay.close();

      expect(audioPreprocess.teardown).toHaveBeenCalledTimes(1);
      // Keyed on THIS connection, so tearing it down can't destroy another live
      // connection's model state for the same resumed session.
      expect(audioPreprocess.teardown).toHaveBeenCalledWith(connectionId);
      expect(vi.mocked(backendFactory.backends[0].close)).toHaveBeenCalledTimes(1);
    });

    it('does not call teardown or ever create a backend if the session was never established (bootstrap failure)', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      orchestrator.createSession = vi.fn().mockResolvedValue(null); // start() fails
      const backendFactory = fakeBackendFactory(orchestrator);
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: () => {} });
      await relay.start();

      relay.close();

      expect(audioPreprocess.teardown).not.toHaveBeenCalled();
      expect(backendFactory.create).not.toHaveBeenCalled();
    });

    it('does not call teardown or backend.close() twice if close() is somehow invoked more than once', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const backendFactory = fakeBackendFactory(orchestrator);
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: () => {} });
      await relay.start();

      relay.close();
      relay.close();

      expect(audioPreprocess.teardown).toHaveBeenCalledTimes(1);
      expect(vi.mocked(backendFactory.backends[0].close)).toHaveBeenCalledTimes(1);
    });

    it('invokes deps.close() once per close() call, when provided', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const closeSpy = vi.fn();
      const relay = new ConnectionRelay({
        audioPreprocess,
        orchestrator,
        backendFactory: fakeBackendFactory(orchestrator),
        claims: CLAIMS,
        send: () => {},
        close: closeSpy,
      });
      await relay.start();

      relay.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('deps.close being omitted does not throw', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {} });
      await relay.start();

      expect(() => relay.close()).not.toThrow();
    });
  });

  describe('sessionId getter', () => {
    it('is null before start(), reflects the established id after start(), and is null again after close()', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const relay = new ConnectionRelay({ audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {} });

      expect(relay.sessionId).toBeNull();
      await relay.start();
      expect(relay.sessionId).toBe('sess-1');
      relay.close();
      expect(relay.sessionId).toBeNull();
    });
  });

  describe('start(resumeInfo)', () => {
    it('succeeds: uses the resumed sessionId/resumeToken, marks resumed=true, and never calls createSession', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      orchestrator.resumeSession = vi.fn().mockResolvedValue({ sessionId: 'sess-1', resumeToken: 'new-tok' });
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay(
        { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
      );

      const ok = await relay.start({ sessionId: 'sess-1', resumeToken: 'old-tok' });

      expect(ok).toBe(true);
      expect(orchestrator.resumeSession).toHaveBeenCalledWith('sess-1', 'old-tok', CLAIMS.sub);
      expect(orchestrator.createSession).not.toHaveBeenCalled();
      expect(jsonSends(sent)[0]).toEqual({ event: 'SESSION_READY', sessionId: 'sess-1', resumeToken: 'new-tok', resumed: true });
    });

    it('with an invalid/stale token: resumeSession resolves null, falls back to createSession, resumed=false, and the call still succeeds', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator(); // resumeSession defaults to resolving null
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay(
        { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: (d) => sent.push(d) },
      );

      const ok = await relay.start({ sessionId: 'sess-1', resumeToken: 'stale-tok' });

      expect(ok).toBe(true); // a bad resume never fails the call
      expect(orchestrator.resumeSession).toHaveBeenCalledWith('sess-1', 'stale-tok', CLAIMS.sub);
      expect(orchestrator.createSession).toHaveBeenCalledTimes(1);
      expect(jsonSends(sent)[0]).toEqual(SESSION_READY); // resumed: false
    });
  });

  describe('protocol-version enforcement (protocolVersionEnforcementEnabled)', () => {
    it('no HELLO before helloTimeoutMs sends ERROR and closes via deps.close(4003, ...) directly -- never through the full close() teardown', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const backendFactory = fakeBackendFactory(orchestrator);
      const closeSpy = vi.fn();
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay(
        { audioPreprocess, orchestrator, backendFactory, claims: CLAIMS, send: (d) => sent.push(d), close: closeSpy },
        { protocolVersionEnforcementEnabled: true, helloTimeoutMs: 3000 },
      );
      await relay.start();

      await vi.advanceTimersByTimeAsync(3000);

      expect(closeSpy).toHaveBeenCalledWith(4003, 'unsupported protocol version');
      expect(jsonSends(sent)).toContainEqual({
        event: 'ERROR',
        code: 'UNSUPPORTED_PROTOCOL_VERSION',
        message: expect.any(String),
        recoverable: false,
      });
      // Locks in the leak fix: this path must go through deps.close directly, never
      // ConnectionRelay's own close() -- proven by sessionId staying set (close() would
      // null it) and neither audioPreprocess.teardown nor backend.close() firing.
      expect(relay.sessionId).toBe('sess-1');
      expect(audioPreprocess.teardown).not.toHaveBeenCalled();
      expect(vi.mocked(backendFactory.backends[0].close)).not.toHaveBeenCalled();
    });

    it('a valid HELLO before the timeout suppresses the close entirely', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const closeSpy = vi.fn();
      const relay = new ConnectionRelay(
        { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {}, close: closeSpy },
        { protocolVersionEnforcementEnabled: true, helloTimeoutMs: 3000 },
      );
      await relay.start();

      relay.handleControlEvent(JSON.stringify({ event: 'HELLO', version: PROTOCOL_VERSION, role: 'ROLE_RECEPTIONIST' }));
      await vi.advanceTimersByTimeAsync(3000);

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('an invalid/wrong-version HELLO does not suppress the timeout', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const closeSpy = vi.fn();
      const relay = new ConnectionRelay(
        { audioPreprocess, orchestrator, backendFactory: fakeBackendFactory(orchestrator), claims: CLAIMS, send: () => {}, close: closeSpy },
        { protocolVersionEnforcementEnabled: true, helloTimeoutMs: 3000 },
      );
      await relay.start();

      relay.handleControlEvent(JSON.stringify({ event: 'HELLO', version: PROTOCOL_VERSION + 1, role: 'ROLE_RECEPTIONIST' }));
      relay.handleControlEvent('not even json');
      await vi.advanceTimersByTimeAsync(3000);

      expect(closeSpy).toHaveBeenCalledWith(4003, 'unsupported protocol version');
    });

    it('a non-recoverable backend error closes the socket once; the hello-timer, if it later fires, does not pile on a redundant close', async () => {
      const orchestrator = fakeOrchestrator({ ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'gone', recoverable: false } });
      const audioPreprocess = fakeAudioPreprocess();
      (audioPreprocess.process as ReturnType<typeof vi.fn>).mockResolvedValue({ frame: frame(1), speechDetected: true });
      const closeSpy = vi.fn();
      const sent: (string | Uint8Array)[] = [];
      const relay = new ConnectionRelay(
        {
          audioPreprocess,
          orchestrator,
          backendFactory: fakeBackendFactory(orchestrator),
          claims: CLAIMS,
          send: (d) => sent.push(d),
          close: closeSpy,
        },
        { protocolVersionEnforcementEnabled: true, helloTimeoutMs: 3000, minUtteranceSpeechMs: 20, maxUtteranceMs: 20 },
      );
      await relay.start();

      await sendFrame(relay, frame(1)); // arms
      await sendFrame(relay, frame(2)); // force-flushes -> the (failing, non-recoverable) turn -- sets `terminated`

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledWith(4004, 'SESSION_NOT_FOUND');
      const sentLengthAfterBackendError = sent.length;
      await vi.advanceTimersByTimeAsync(3000);

      expect(closeSpy).toHaveBeenCalledTimes(1); // still just the one close -- no redundant close from the hello-timer path
      expect(sent.length).toBe(sentLengthAfterBackendError); // no second ERROR appended
    });

    it('at the default (protocolVersionEnforcementEnabled: false), no timer is ever armed regardless of whether HELLO arrives', async () => {
      const audioPreprocess = fakeAudioPreprocess();
      const orchestrator = fakeOrchestrator();
      const closeSpy = vi.fn();
      const relay = new ConnectionRelay({
        audioPreprocess,
        orchestrator,
        backendFactory: fakeBackendFactory(orchestrator),
        claims: CLAIMS,
        send: () => {},
        close: closeSpy,
      }); // no config override -- DEFAULT_RELAY_CONFIG.protocolVersionEnforcementEnabled === false
      await relay.start();

      await vi.advanceTimersByTimeAsync(60_000); // well past any realistic helloTimeoutMs
      expect(closeSpy).not.toHaveBeenCalled();
    });
  });
});
