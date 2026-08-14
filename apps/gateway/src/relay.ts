import { randomUUID } from 'node:crypto';
import { BinaryFrameType, encodeBinaryFrame, type ServerControlEvent } from '@vita/protocol';
import type { AudioPreprocessClient } from './audioPreprocessClient.js';
import type { OrchestratorClient, RelayError } from './orchestratorClient.js';
import type { SessionClaims } from './ticket.js';
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
  send: (data: string | Uint8Array) => void;
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
  private sessionId: string | null = null;
  private backend: TurnBackend | null = null;

  private buffer: Uint8Array[] = [];
  private preRoll: Uint8Array[] = [];
  private accumulating = false;
  private armed = false;
  private speechRunMs = 0;
  private silenceRunMs = 0;

  private bargeInArmed = false;
  private bargeInTimer: ReturnType<typeof setTimeout> | undefined;

  private frameQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: RelayDeps,
    config?: Partial<RelayConfig>,
  ) {
    this.config = { ...DEFAULT_RELAY_CONFIG, ...config };
  }

  async start(): Promise<boolean> {
    const result = await this.deps.orchestrator.createSession({
      sessionId: randomUUID(),
      userId: this.deps.claims.sub,
      role: this.deps.claims.role,
    });
    if (!result) return false;
    this.sessionId = result.sessionId;
    // create() never throws -- it always resolves to *some* backend (streaming, or a
    // batch fallback if streaming is disabled/unavailable), so this can't fail this
    // call the way the createSession() check above can.
    this.backend = await this.deps.backendFactory.create(this.sessionId, {
      onPartialTranscript: (text) => this.onPartialTranscript(text),
      onFinalTranscript: (text) => this.onFinalTranscript(text),
      onReplyAudio: (audio) => this.onReplyAudio(audio),
      onError: (error) => this.onBackendError(error),
    });
    return true;
  }

  handleAudioFrame(frame: Uint8Array): void {
    this.frameQueue = this.frameQueue.then(() => this.processFrame(frame)).catch((err) => {
      this.deps.log?.warn({ err }, 'relay: frame processing failed');
    });
  }

  handleControlEvent(raw: string): void {
    // HELLO is the only client control event the protocol defines, and it's advisory-only
    // (role comes from the JWT, already resolved before ConnectionRelay exists) -- nothing
    // to act on beyond observability.
    this.deps.log?.debug({ msg: raw }, 'relay: control event received');
  }

  close(): void {
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    if (this.sessionId) {
      // Fire-and-forget, same pattern as start()'s call below -- frees this session's
      // model state in audio-preprocess promptly rather than waiting out its TTL
      // safety net. Capture the id before clearing it.
      const sessionId = this.sessionId;
      void this.deps.audioPreprocess.teardown(sessionId).catch((err) => {
        this.deps.log?.warn({ err }, 'relay: audio-preprocess teardown failed');
      });
      this.backend?.close();
    }
    this.sessionId = null;
  }

  private async processFrame(frame: Uint8Array): Promise<void> {
    if (!this.sessionId) return; // bootstrap failed, or a prior turn ended the session (non-recoverable error)

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
    const { frame: denoised, speechDetected } = await this.deps.audioPreprocess.process(frame, this.sessionId!);

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

    const { speechDetected } = await this.deps.audioPreprocess.process(frame, this.sessionId!);
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
    this.deps.log?.debug({ transcript: text }, 'relay: final transcript received');
    this.sendJson({ event: 'TRANSCRIPT', text, is_final: true });
  }

  private onReplyAudio(audio: Uint8Array): void {
    void this.speak(audio).catch((err) => {
      this.deps.log?.warn({ err }, 'relay: speak() failed unexpectedly');
    });
  }

  private onBackendError(error: RelayError): void {
    this.sendJson({ event: 'ERROR', code: error.code, message: error.message, recoverable: error.recoverable });
    if (error.recoverable) {
      this.setState('LISTENING');
    } else {
      this.sendJson({ event: 'STATE_CHANGE', state: 'ERROR' });
      this.sessionId = null; // stop relaying entirely until the client reconnects
    }
  }

  private async speak(audioBytes: Uint8Array): Promise<void> {
    this.setState('SPEAKING');
    for (let i = 0; i < audioBytes.length; i += this.config.outboundChunkBytes) {
      const chunk = audioBytes.subarray(i, i + this.config.outboundChunkBytes);
      this.deps.send(encodeBinaryFrame(BinaryFrameType.AUDIO_OUTPUT_PCM16, chunk));
    }

    // Sending is near-instant, but the client's jitter-buffer playback continues for the
    // real clip duration afterward -- SPEAKING (and the barge-in-armed window) must last
    // that long, not just as long as the send loop took. 16-bit mono PCM16 @16kHz.
    const durationMs = (audioBytes.length / 2 / 16000) * 1000;
    this.bargeInArmed = false;
    this.speechRunMs = 0;
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = setTimeout(() => {
      if (this.state === 'SPEAKING') this.bargeInArmed = true;
    }, this.config.bargeInGraceMs);

    await delay(durationMs);
    if (this.state === 'SPEAKING') {
      // No-op if triggerBargeIn already moved the state on while we were waiting.
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
