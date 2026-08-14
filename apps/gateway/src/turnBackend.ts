import type { OrchestratorClient, RelayError } from './orchestratorClient.js';

/**
 * The Strategy split behind real-time streaming STT: ConnectionRelay (relay.ts) owns
 * *when* an utterance starts/ends (VAD segmentation, pre-roll, hangover, barge-in --
 * all unchanged by this). TurnBackend owns *how* a finished (or in-progress) utterance
 * turns into a transcript + spoken reply. Two implementations: BatchTurnBackend (this
 * file -- today's exact existing behavior, kept as a first-class fallback) and
 * StreamingTurnBackend (streamingTurnBackend.ts -- real-time, forwards audio as it
 * arrives). ConnectionRelay depends only on these interfaces, never on a concrete
 * transport, matching the constructor-injection convention every other client in this
 * codebase already uses (AudioPreprocessClient, OrchestratorClient, ...).
 */

export interface TurnBackendEvents {
  onPartialTranscript(text: string): void;
  /** '' == soft no-op -- VAD armed an utterance but STT heard no words, same convention
   * TurnAudioResult.transcript already uses. */
  onFinalTranscript(text: string): void;
  /** Whole synthesized reply for the turn; ConnectionRelay.speak() still owns chunking
   * it for browser-facing playback -- see docs/BUILD_GUIDE.md plan notes on why
   * chunking stays there, not here. */
  onReplyAudio(audio: Uint8Array): void;
  onError(error: RelayError): void;
}

export interface TurnBackend {
  /** Fires once, at the ARMED transition (not the first speech frame) -- a
   * sub-threshold VAD blip (cough, breath) must never open a Sarvam connection.
   * Must never throw; failures go through TurnBackendEvents.onError. */
  beginUtterance(): void;
  /** Fires once per frame ConnectionRelay has already decided belongs to the
   * accumulating utterance, starting with a replay of everything buffered at the
   * arming instant (pre-roll + onset), then live thereafter. */
  pushFrame(frame: Uint8Array): void;
  /** Fires once when ConnectionRelay's hangover/maxUtteranceMs math ends the
   * utterance. fullAudio is BatchTurnBackend's entire payload; StreamingTurnBackend
   * ignores it (already streamed via pushFrame) -- an accepted ISP tradeoff for only
   * two implementations, not hidden. */
  endUtterance(fullAudio: Uint8Array): void;
  /** Call-teardown, mirrors ConnectionRelay.close()'s existing fire-and-forget pattern. */
  close(): void;
}

export interface TurnBackendFactory {
  /** All connection setup, and the streaming-vs-batch fallback decision, happens here,
   * once, at call start. Never throws -- always resolves to *some* backend. */
  create(sessionId: string, events: TurnBackendEvents): Promise<TurnBackend>;
}

/** Today's exact existing behavior (previously ConnectionRelay.endOfUtterance()'s HTTP-call
 * half), kept as a first-class fallback so a rejected/unavailable Sarvam realtime
 * connection degrades a call gracefully instead of failing it outright. */
export class BatchTurnBackend implements TurnBackend {
  constructor(
    private readonly orchestrator: OrchestratorClient,
    private readonly sessionId: string,
    private readonly events: TurnBackendEvents,
  ) {}

  beginUtterance(): void {
    // Nothing to signal ahead of time -- the whole utterance is sent in one shot below.
  }

  pushFrame(): void {
    // No-op: ConnectionRelay already retains the full buffer regardless (needed for its
    // own maxUtteranceMs bookkeeping), so there's no separate buffer to maintain here.
  }

  endUtterance(fullAudio: Uint8Array): void {
    void this.orchestrator.postAudioTurn(this.sessionId, fullAudio).then(
      (result) => {
        if (!result.ok) {
          this.events.onError(result.error);
          return;
        }
        this.events.onFinalTranscript(result.data.transcript);
        // audioBase64 is null iff transcript === '' (see TurnAudioResponse) -- possibly an
        // empty string otherwise, which is still a real (silent) reply, not "no reply".
        if (result.data.transcript.trim()) {
          this.events.onReplyAudio(Buffer.from(result.data.audioBase64!, 'base64'));
        }
      },
      (err) => {
        this.events.onError({ code: 'BACKEND_FAILURE', message: String(err), recoverable: true });
      },
    );
  }

  close(): void {
    // Nothing to tear down -- postAudioTurn is a plain request/response call.
  }
}
