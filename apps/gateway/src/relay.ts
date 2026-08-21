import { randomUUID } from 'node:crypto';
import { BinaryFrameType, encodeBinaryFrame, ClientControlEvent, type ServerControlEvent } from '@vita/protocol';
import type { AudioPreprocessClient } from './audioPreprocessClient.js';
import type { OrchestratorClient, RelayError } from './orchestratorClient.js';
import type { ResumeIntent, SessionClaims } from './ticket.js';
import type { TurnBackend, TurnBackendFactory } from './turnBackend.js';

export type RelayState = 'LISTENING' | 'PROCESSING' | 'SPEAKING';

export interface RelayConfig {
  frameMs: number; // fixed by the AudioWorklet's 320-sample output -- not meant to be tuned
  silenceHangoverMs: number;
  minUtteranceSpeechMs: number;
  maxUtteranceMs: number;
  preRollFrames: number;
  outboundChunkBytes: number;
  bargeInEnabled: boolean;
  bargeInGraceMs: number;
  /** How long to wait for a valid HELLO before rejecting the connection -- only
   * enforced when protocolVersionEnforcementEnabled is true. HELLO is sent
   * synchronously in the client's ws.onopen (no getUserMedia/mic-permission
   * dependency), so this is generous headroom, not a tight budget. */
  helloTimeoutMs: number;
  /** Ships dark (default false), same rollout posture as STREAMING_STT_ENABLED --
   * this feature's blast radius spans protocol+gateway+web-sdk, and its failure mode
   * for an unaccounted-for client (a permanent reconnect-loop, since an old client's
   * onclose handler predates the 4003 special-case) is worse than e.g.
   * SESSION_RESUME_ENABLED's, so it needs the more conservative default. */
  protocolVersionEnforcementEnabled: boolean;
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  frameMs: 20,
  silenceHangoverMs: 700,
  minUtteranceSpeechMs: 300,
  maxUtteranceMs: 20_000,
  preRollFrames: 5,
  outboundChunkBytes: 3200,
  bargeInEnabled: true,
  bargeInGraceMs: 300,
  helloTimeoutMs: 3000,
  protocolVersionEnforcementEnabled: false,
};

export interface RelayLogger {
  debug: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface RelayDeps {
  audioPreprocess: AudioPreprocessClient;
  orchestrator: OrchestratorClient;
  backendFactory: TurnBackendFactory;
  claims: SessionClaims;
  /** From the redeemed ticket (see ticket.ts). Optional/defaults to false purely so
   * existing test literals that predate this field keep compiling -- real production
   * wiring (index.ts) always supplies it explicitly. Forwarded to the orchestrator's
   * POST /session on a fresh session only; resume never re-proves consent. */
  consentGiven?: boolean;
  send: (data: string | Uint8Array) => void;
  /** Severs the underlying transport. Optional (mirrors `log?`) -- existing unit tests
   * that don't care about socket lifecycle can omit it. Production wiring (index.ts) sets
   * this to close the real WS socket, so RelaySessionRegistry.evict() can fully retire a
   * stale connection on resume -- close() itself never touched the socket before this,
   * so without it an evicted connection's relay state would die but the socket would stay
   * open forever.
   *
   * code/reason are optional and default (in index.ts's wiring) to the historical
   * 4009/"session resumed on a new connection" close -- every existing no-args caller
   * (this file's own close(), RelaySessionRegistry.evict()) keeps that exact behavior
   * unchanged. A caller with a genuinely different reason (e.g. the hello-timeout below)
   * passes its own code/reason through instead. */
  close?: (code?: number, reason?: string) => void;
  log?: RelayLogger;
}

function concatFrames(frames: Uint8Array[]): Uint8Array {
  return Buffer.concat(frames);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns one WS connection's worth of relay state: VAD-based utterance segmentation,
 * buffering, and the LISTENING/PROCESSING/SPEAKING lifecycle -- see docs/BUILD_GUIDE.md
 * §3.3 and the plan this implements for why this logic lives here rather than in the
 * orchestrator. All I/O is injected via RelayDeps so this is unit-testable without a
 * real socket or real HTTP calls.
 */
export class ConnectionRelay {
  private readonly config: RelayConfig;

  private state: RelayState = 'LISTENING';
  private _sessionId: string | null = null;
  /**
   * Key for this connection's audio-preprocess state (Silero VAD + DeepFilterNet), which
   * is per-CONNECTION, deliberately NOT per-orchestrator-session.
   *
   * Those models' state is a property of one continuous audio stream from one mic, not of
   * a dialogue. Keying on sessionId (as this used to) meant a resumed connection inherited
   * the previous connection's model state across an arbitrary gap -- different gain,
   * different room, possibly minutes later -- and, worse, that two relays for the same
   * session would interleave two independent audio streams into ONE VAD/denoiser record
   * (apps/audio-preprocess/app/session_registry.py keys strictly on whatever id it's
   * given), with the loser's teardown then destroying the winner's live state.
   */
  private readonly _connectionId: string = randomUUID();
  private backend: TurnBackend | null = null;
  /** Set synchronously by onBackendError's non-recoverable branch -- distinct from
   * _sessionId, which deliberately stays valid until the socket's real 'close' event runs
   * close() (onBackendError hands off to deps.close() directly rather than nulling
   * _sessionId itself, mirroring the hello-timeout path below, so index.ts's close
   * handler can still see a real sessionId to unregister/tear down with). Frame
   * processing and the hello-timeout guard check THIS instead, so a connection that's
   * mid-teardown but whose socket hasn't actually finished closing yet doesn't keep
   * relaying audio or fire a second, redundant fatal error. */
  private terminated = false;

  private buffer: Uint8Array[] = [];
  private preRoll: Uint8Array[] = [];
  private accumulating = false;
  private armed = false;
  private speechRunMs = 0;
  private silenceRunMs = 0;

  private bargeInArmed = false;
  private bargeInTimer: ReturnType<typeof setTimeout> | undefined;

  // -- Protocol-version enforcement (ships dark, see RelayConfig.protocolVersionEnforcementEnabled) --
  private helloReceived = false;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;

  // -- Multi-chunk speak() bookkeeping (streaming replies) --
  /** Bumped once per turn, in startEndOfUtterance() -- the authoritative "a new turn's
   * reply is now expected" signal. */
  private turnGeneration = 0;
  /** True only in the window between startEndOfUtterance() dispatching a turn and
   * speak() claiming its first chunk -- see speak()'s own comment for why this (not
   * `state !== 'SPEAKING'`) is the thing that decides whether an incoming chunk is
   * allowed to open a new SPEAKING window. */
  private awaitingFirstReplyChunk = false;
  /** Non-null while a turn "owns" SPEAKING; set by speak()'s first chunk, cleared either
   * when that turn's final chunk finishes or immediately on barge-in. */
  private speakingGeneration: number | null = null;
  private turnAudioDurationMs = 0;
  private turnSpeakingStartedAt = 0;

  private frameQueue: Promise<void> = Promise.resolve();

  /** Resolves once start() concludes, success or failure -- awaited by processFrame() for
   * any frame that arrives before then (see that method's own comment) so audio received
   * during the orchestrator session-bootstrap window is buffered-by-waiting rather than
   * silently dropped. Also resolved by close() in the unusual case that the connection is
   * torn down before start() itself ever concludes. */
  private sessionReady: Promise<void>;
  private resolveSessionReady: () => void = () => {};
  /** True only once BOTH _sessionId AND backend are assigned (or start() has definitively
   * failed) -- deliberately NOT the same check as `!this._sessionId` alone. _sessionId is
   * assigned synchronously, before the (potentially slow -- a real streaming-backend
   * connect attempt) `await backendFactory.create(...)` that assigns `backend`. A frame
   * arriving in that gap would see _sessionId already truthy and skip waiting entirely,
   * then call this.backend?.pushFrame()/etc. while backend is still null -- silently
   * no-op'd by optional chaining, permanently losing that utterance's VAD state with no
   * further frames ever able to recover it. processFrame() gates on this flag instead. */
  private sessionEstablished = false;

  constructor(
    private readonly deps: RelayDeps,
    config?: Partial<RelayConfig>,
  ) {
    this.config = { ...DEFAULT_RELAY_CONFIG, ...config };
    this.sessionReady = new Promise((resolve) => {
      this.resolveSessionReady = resolve;
    });
  }

  /** Read-only accessor for the established orchestrator sessionId -- null before start()
   * resolves and after close(). Lets index.ts register/unregister this relay in
   * RelaySessionRegistry without changing start()'s Promise<boolean> contract. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Read-only accessor for this connection's audio-preprocess key (see _connectionId).
   * Stable for the relay's whole lifetime, unlike sessionId. Exposed so tests can assert
   * the exact key rather than degrading to expect.any(String). */
  get connectionId(): string {
    return this._connectionId;
  }

  async start(resumeInfo?: ResumeIntent): Promise<boolean> {
    let established: { sessionId: string; resumeToken: string; epoch: number; resumed: boolean } | null = null;

    if (resumeInfo) {
      // userId is always the JWT-verified claims.sub, never anything from the
      // client-supplied resume pair -- a client can't forge ownership of a session it
      // doesn't hold the JWT identity for. resumeSession() never throws; null means
      // "can't resume" (invalid/expired/mismatched/unreachable), and this call must
      // never fail -- it just silently falls through to a fresh session below, same
      // graceful-degrade philosophy as the streaming->batch backend fallback.
      const resumed = await this.deps.orchestrator.resumeSession(resumeInfo.sessionId, resumeInfo.resumeToken, this.deps.claims.sub);
      if (resumed) established = { ...resumed, resumed: true };
    }

    if (!established) {
      const created = await this.deps.orchestrator.createSession({
        sessionId: randomUUID(),
        userId: this.deps.claims.sub,
        consentGiven: this.deps.consentGiven ?? false,
        hospitalId: this.deps.claims.hospitalId,
        hmsAccessToken: this.deps.claims.hmsAccessToken,
      });
      if (!created) {
        this.sessionEstablished = true;
        this.resolveSessionReady(); // unblock any frame already waiting in processFrame() -- there's no session to process it against
        return false;
      }
      established = { ...created, resumed: false };
    }

    this._sessionId = established.sessionId;
    // create() never throws -- it always resolves to *some* backend (streaming, or a
    // batch fallback if streaming is disabled/unavailable), so this can't fail this
    // call the way the createSession()/resumeSession() checks above can.
    this.backend = await this.deps.backendFactory.create({ sessionId: this._sessionId, epoch: established.epoch }, {
      onPartialTranscript: (text) => this.onPartialTranscript(text),
      onFinalTranscript: (text) => this.onFinalTranscript(text),
      onReplyText: (text) => this.onReplyText(text),
      onReplyAudio: (audio, isFinalChunk) => this.onReplyAudio(audio, isFinalChunk),
      onFormAutofill: (data) => this.onFormAutofill(data),
      onError: (error) => this.onBackendError(error),
    });
    this.sessionEstablished = true;
    this.resolveSessionReady(); // unblocks any frame that arrived (and is waiting in processFrame()) before this point
    this.sendJson({
      event: 'SESSION_READY',
      sessionId: established.sessionId,
      resumeToken: established.resumeToken,
      resumed: established.resumed,
    });

    if (this.config.protocolVersionEnforcementEnabled) {
      this.helloTimer = setTimeout(() => {
        // this.terminated: an unrelated non-recoverable backend error (onBackendError)
        // may already be tearing this connection down -- don't pile a second, unrelated
        // fatal error onto it.
        if (this.helloReceived || this.terminated) return;
        this.sendJson({
          event: 'ERROR',
          code: 'UNSUPPORTED_PROTOCOL_VERSION',
          message: 'no valid HELLO received within the grace period (missing or unsupported protocol version)',
          recoverable: false,
        });
        // deps.close directly, NOT this.close() -- this.close() nulls _sessionId before
        // the socket's real 'close' event fires, which would make index.ts's
        // socket.on('close', ...) handler (the only place that unregisters a session
        // from RelaySessionRegistry) find sessionId already null and silently skip
        // unregistering -- an unbounded leak on every rejection. Let that existing
        // handler do teardown/unregistration exactly like it does for every other close
        // reason; this call's only job is severing the raw transport with the right code.
        this.deps.close?.(4003, 'unsupported protocol version');
      }, this.config.helloTimeoutMs);
    }

    return true;
  }

  handleAudioFrame(frame: Uint8Array): void {
    this.frameQueue = this.frameQueue.then(() => this.processFrame(frame)).catch((err) => {
      this.deps.log?.warn({ err }, 'relay: frame processing failed');
    });
  }

  handleControlEvent(raw: string): void {
    // HELLO is the only client control event the protocol defines. Its `role` field is
    // still advisory-only (role comes from the JWT, already resolved before
    // ConnectionRelay exists) -- the only thing acted on here is `version`, for the
    // ships-dark protocol-version enforcement above. ClientControlEvent's version field
    // is a z.literal(PROTOCOL_VERSION), so a wrong-version HELLO and a malformed message
    // are treated identically (parse failure) -- no separate distinction needed, same as
    // how "invalid or expired ticket" doesn't distinguish its own sub-cases either; the
    // raw string is still logged below regardless of parse outcome.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && ClientControlEvent.safeParse(parsed).success) {
      this.helloReceived = true;
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = undefined;
      }
    }
    this.deps.log?.debug({ msg: raw }, 'relay: control event received');
  }

  close(): void {
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this._sessionId) {
      // Fire-and-forget, same pattern as start()'s call below -- frees THIS CONNECTION's
      // model state in audio-preprocess promptly rather than waiting out its TTL safety
      // net. Keyed on _connectionId (see that field's doc comment), so tearing this
      // connection down can never destroy a different, still-live connection's state --
      // which is exactly what happened when this was keyed on the shared sessionId.
      void this.deps.audioPreprocess.teardown(this._connectionId).catch((err) => {
        this.deps.log?.warn({ err }, 'relay: audio-preprocess teardown failed');
      });
      this.backend?.close();
    }
    this._sessionId = null;
    this.sessionEstablished = true;
    this.resolveSessionReady(); // in case close() runs before start() itself ever concludes -- no-op (already resolved) otherwise
    // Unconditional & idempotent -- calling .close() on an already-closed socket is a
    // documented no-op, same precedent stopSession() already relies on in the web-sdk.
    this.deps.close?.();
  }

  private async processFrame(frame: Uint8Array): Promise<void> {
    if (this.terminated) return;
    if (!this.sessionEstablished) {
      // start() hasn't fully concluded yet -- audio frames flow in as soon as the WS
      // opens (index.ts registers the message handler without awaiting start()), well
      // before an orchestrator session-bootstrap HTTP call (and, for a streaming-enabled
      // call, a real backend connect attempt on top of that) typically completes. Wait
      // rather than drop: frameQueue already serializes every call to this method in
      // arrival order, so waiting here (instead of a separate buffer-then-replay
      // mechanism) keeps buffered and live frames in that same strict order for free.
      // sessionReady always eventually resolves (start() succeeds, fails, or close() runs
      // first) -- see their own resolveSessionReady() call sites. Gated on
      // sessionEstablished, NOT `!this._sessionId` -- see that field's own doc comment
      // for why checking _sessionId alone here re-opens the exact race this exists to
      // close (backend can still be null even once _sessionId is truthy).
      await this.sessionReady;
      if (this.terminated || !this._sessionId) return; // start() failed, or this connection has since been torn down
    }

    if (this.state === 'PROCESSING') {
      // No overlapping turns in Phase 1 -- audio received mid-turn is dropped, not queued.
      return;
    }
    if (this.state === 'LISTENING') {
      return this.processListeningFrame(frame);
    }
    if (this.state === 'SPEAKING') {
      return this.processSpeakingFrame(frame);
    }
  }

  private async processListeningFrame(frame: Uint8Array): Promise<void> {
    const { frame: denoised, speechDetected } = await this.deps.audioPreprocess.process(frame, this._connectionId);

    if (!this.accumulating) {
      if (!speechDetected) {
        this.preRoll.push(denoised);
        if (this.preRoll.length > this.config.preRollFrames) this.preRoll.shift();
        return;
      }
      // First speech frame of a new utterance -- prepend the pre-roll so STT doesn't clip
      // the onset of the first word.
      this.buffer.push(...this.preRoll, denoised);
      this.preRoll = [];
      this.accumulating = true;
      this.speechRunMs = this.config.frameMs;
      this.silenceRunMs = 0;
      if (this.speechRunMs >= this.config.minUtteranceSpeechMs) this.armUtterance();
      return;
    }

    this.buffer.push(denoised);
    if (speechDetected) {
      this.speechRunMs += this.config.frameMs;
      this.silenceRunMs = 0;
      if (!this.armed && this.speechRunMs >= this.config.minUtteranceSpeechMs) {
        this.armUtterance();
      } else if (this.armed) {
        this.backend?.pushFrame(denoised);
      }
    } else {
      this.silenceRunMs += this.config.frameMs;
      this.speechRunMs = 0;
      if (this.armed) this.backend?.pushFrame(denoised);
    }

    if (this.armed && this.silenceRunMs >= this.config.silenceHangoverMs) {
      this.startEndOfUtterance();
      return;
    }
    const utteranceMs = this.buffer.length * this.config.frameMs;
    if (utteranceMs >= this.config.maxUtteranceMs) {
      // Safety valve, not a feature -- force-flush a stuck buffer (e.g. sustained
      // background noise VAD never clears) rather than growing it unboundedly.
      this.startEndOfUtterance();
    }
  }

  /** Fires TurnBackend.beginUtterance() exactly once per utterance, at the moment
   * `armed` transitions to true -- not the first speech frame, so a sub-threshold VAD
   * blip never opens a streaming connection. Replays everything buffered so far
   * (pre-roll + onset, since this.buffer already includes the current frame by the time
   * either call site reaches this) so the backend sees the same audio a batch call
   * would have; every later frame is forwarded live via pushFrame() at its own call site. */
  private armUtterance(): void {
    this.armed = true;
    this.backend?.beginUtterance();
    for (const bufferedFrame of this.buffer) {
      this.backend?.pushFrame(bufferedFrame);
    }
  }

  private async processSpeakingFrame(frame: Uint8Array): Promise<void> {
    if (!this.config.bargeInEnabled || !this.bargeInArmed) return;

    const { speechDetected } = await this.deps.audioPreprocess.process(frame, this._connectionId);
    if (speechDetected) {
      this.speechRunMs += this.config.frameMs;
    } else {
      this.speechRunMs = 0;
    }

    if (this.speechRunMs >= this.config.minUtteranceSpeechMs) {
      this.triggerBargeIn();
    }
  }

  /**
   * Synchronously snapshots the buffered utterance and flips to PROCESSING (so the very
   * next frame the frameQueue processes already sees the new state), then hands off to
   * the backend's endUtterance() *without* awaiting it here. This is deliberate:
   * processFrame()/processListeningFrame() run serialized through frameQueue, so if this
   * method awaited the turn directly, every frame arriving during PROCESSING would queue
   * up behind it and only ever be evaluated (and correctly dropped) *after* it already
   * resolved -- the PROCESSING-drop branch in processFrame would never observably fire,
   * and barge-in detection during the SPEAKING that follows would be equally stalled.
   * The TurnBackend interface contract requires implementations to never let a failure
   * escape endUtterance() itself (each backend catches its own async work and routes
   * failures through TurnBackendEvents.onError instead), so there's nothing left to
   * .catch() here -- detaching stays this simple.
   */
  private startEndOfUtterance(): void {
    const audio = concatFrames(this.buffer);
    this.resetUtteranceState();
    this.turnGeneration++;
    this.awaitingFirstReplyChunk = true; // only now is an incoming reply chunk allowed to open SPEAKING -- see speak()
    this.setState('PROCESSING');
    this.backend?.endUtterance(audio);
  }

  // -- TurnBackendEvents callbacks, wired in start(). Together these do exactly what
  // endOfUtterance()'s inline code used to, just triggered asynchronously from whichever
  // backend is active instead of after one awaited HTTP call. --

  private onPartialTranscript(text: string): void {
    this.sendJson({ event: 'TRANSCRIPT', text, is_final: false });
  }

  private onFinalTranscript(text: string): void {
    if (!text.trim()) {
      // Soft no-op: VAD armed an utterance but STT heard no words (cough/breath/noise).
      // Deliberately not an ERROR -- expected/normal, just resume listening silently.
      this.setState('LISTENING');
      return;
    }
    // Length only, never the transcript content itself -- this is PHI-adjacent (patient
    // names, mobile numbers, symptoms), and Fastify's default log level (info) hides
    // debug today, but the moment anyone bumps to debug for ordinary troubleshooting
    // (a normal ops action) this would otherwise start writing that content to logs.
    this.deps.log?.debug({ transcriptLength: text.length }, 'relay: final transcript received');
    this.sendJson({ event: 'TRANSCRIPT', text, is_final: true });
  }

  private onReplyText(text: string): void {
    this.sendJson({ event: 'REPLY_TEXT', text });
  }

  private onReplyAudio(audio: Uint8Array, isFinalChunk: boolean): void {
    void this.speak(audio, isFinalChunk).catch((err) => {
      this.deps.log?.warn({ err }, 'relay: speak() failed unexpectedly');
    });
  }

  private onFormAutofill(data: Record<string, unknown>): void {
    // No gate here -- the orchestrator's own permission gate (session.permissions, see
    // apps/orchestrator/src/index.ts's computeFormFields, isToolAllowed('book_appointment',
    // ...)) is the sole authoritative check, matching this codebase's own precedent that
    // every other authorization decision already lives orchestrator-side. claims.role no
    // longer exists on the wire at all (persona/permissions are derived server-side from
    // real resolved data, never trusted from the ticket) -- there is nothing left here to
    // redundantly check against.
    this.sendJson({ event: 'UI_FORM_AUTOFILL', data });
  }

  private onBackendError(error: RelayError): void {
    this.sendJson({ event: 'ERROR', code: error.code, message: error.message, recoverable: error.recoverable });
    if (error.recoverable) {
      this.setState('LISTENING');
    } else {
      this.sendJson({ event: 'STATE_CHANGE', state: 'ERROR' });
      this.terminated = true; // stop relaying further audio immediately, even though the socket itself may take a moment to actually finish closing
      // Close the underlying transport, not just this relay's own bookkeeping -- so the
      // socket's real 'close' handler (index.ts) runs relay.close(), which tears down
      // audioPreprocess state AND this.backend (e.g. a persistent internal orchestrator
      // stream WS for a streaming-backend call) and unregisters from
      // RelaySessionRegistry. Previously this only nulled _sessionId locally: the socket
      // itself, and everything downstream of it, stayed open/leaked indefinitely, and the
      // client had no way to recover -- neither web-sdk's ERROR nor STATE_CHANGE handling
      // triggers a reconnect, only a real socket close does (see web-sdk's ws.onclose).
      //
      // deps.close directly, NOT this.close() -- same reasoning as the hello-timeout path
      // above: this.close() would null _sessionId before the socket's real 'close' event
      // fires, making index.ts's handler find sessionId already null and silently skip
      // unregistering/tearing down. Code 4004 (distinct from 4003's non-retriable
      // protocol-version rejection) so web-sdk's onclose falls into its default,
      // reconnect-eligible branch.
      this.deps.close?.(4004, error.code);
    }
  }

  /**
   * A turn's reply can now arrive as multiple chunks (one per sentence, streamed as each
   * is synthesized) instead of always exactly one. speak() is called once per chunk, via
   * independent fire-and-forget onReplyAudio() invocations, so it has to reassemble "one
   * turn's worth of speaking" out of calls that arrive at unpredictable times without
   * corrupting an earlier/later chunk of the SAME turn, or a stale chunk resurfacing
   * audio from a turn the user already interrupted.
   *
   * The key invariant is `awaitingFirstReplyChunk`: an incoming chunk is only ever
   * allowed to OPEN a new SPEAKING window when that flag is true, and it's true ONLY in
   * the window between startEndOfUtterance() dispatching a turn and this method claiming
   * that turn's first chunk. `state !== 'SPEAKING'` alone is NOT a safe proxy for "this
   * is a legitimate new turn's first chunk" -- triggerBargeIn() also resets state to
   * LISTENING, and a stale chunk (already in flight server-side when the abort fired)
   * arriving in that same window would otherwise be mistaken for a fresh turn and
   * re-open SPEAKING with content the user just interrupted. triggerBargeIn() explicitly
   * clears `awaitingFirstReplyChunk` too, so nothing can claim the lock again until the
   * NEXT real utterance actually completes and dispatches its own turn.
   */
  private async speak(audioBytes: Uint8Array, isFinalChunk: boolean): Promise<void> {
    if (this.speakingGeneration === null) {
      if (!this.awaitingFirstReplyChunk) return; // stale -- no turn is currently expecting a reply
      this.awaitingFirstReplyChunk = false;
      this.speakingGeneration = this.turnGeneration;
      this.setState('SPEAKING');
      this.turnAudioDurationMs = 0;
      this.turnSpeakingStartedAt = Date.now();
      this.bargeInArmed = false;
      this.speechRunMs = 0;
      if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
      // Armed once, early in the turn -- not deferred until the LAST of possibly several
      // chunks -- so multi-sentence replies don't regress barge-in responsiveness versus
      // today's single-chunk case.
      this.bargeInTimer = setTimeout(() => {
        if (this.state === 'SPEAKING') this.bargeInArmed = true;
      }, this.config.bargeInGraceMs);
    } else if (this.speakingGeneration !== this.turnGeneration) {
      // Defensive: the turn we'd locked onto has since been superseded some other way.
      return;
    }

    for (let i = 0; i < audioBytes.length; i += this.config.outboundChunkBytes) {
      const chunk = audioBytes.subarray(i, i + this.config.outboundChunkBytes);
      this.deps.send(encodeBinaryFrame(BinaryFrameType.AUDIO_OUTPUT_PCM16, chunk));
    }
    // 16-bit mono PCM16 @16kHz.
    this.turnAudioDurationMs += (audioBytes.length / 2 / 16000) * 1000;

    if (!isFinalChunk) return;

    // Sending is near-instant, but the client's jitter-buffer playback continues for the
    // turn's full accumulated duration afterward -- SPEAKING must last that long. Timed
    // from when speaking STARTED, not just this chunk's own length, since earlier chunks
    // may already have been playing for a while by the time the last one is sent.
    const remainingMs = Math.max(0, this.turnAudioDurationMs - (Date.now() - this.turnSpeakingStartedAt));
    await delay(remainingMs);
    if (this.state === 'SPEAKING' && this.speakingGeneration !== null) {
      // No-op if triggerBargeIn already released the lock while we waited.
      this.speakingGeneration = null; // ready for the NEXT turn's first chunk to claim
      this.setState('LISTENING');
    }
  }

  private triggerBargeIn(): void {
    this.state = 'LISTENING';
    this.sendJson({ event: 'CLEAR_PLAYBACK', reason: 'USER_BARGE_IN' });
    this.sendJson({ event: 'STATE_CHANGE', state: 'LISTENING' });
    this.resetUtteranceState();
    this.bargeInArmed = false;
    if (this.bargeInTimer) {
      clearTimeout(this.bargeInTimer);
      this.bargeInTimer = undefined;
    }
    // Release the lock immediately and stop expecting a reply until the NEXT real
    // utterance dispatches its own turn -- this (not a generation-number comparison
    // alone) is what stops a chunk still in flight from the interrupted turn from being
    // mistaken for a fresh one and reopening SPEAKING with audio the user just cut off.
    this.speakingGeneration = null;
    this.awaitingFirstReplyChunk = false;
    // Tells the backend to stop generating/synthesizing further chunks for the
    // interrupted turn -- the primary defense (stops chunks at the source); the guard
    // above is then just a backstop for the one chunk that may already be in flight.
    this.backend?.abortActiveTurn();
  }

  private resetUtteranceState(): void {
    this.buffer = [];
    this.preRoll = [];
    this.accumulating = false;
    this.armed = false;
    this.speechRunMs = 0;
    this.silenceRunMs = 0;
  }

  private setState(state: RelayState): void {
    this.state = state;
    this.sendJson({ event: 'STATE_CHANGE', state });
  }

  private sendJson(event: ServerControlEvent): void {
    this.deps.send(JSON.stringify(event));
  }
}
