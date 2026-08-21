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
  /** The assistant's reply as text -- fired once per turn for BatchTurnBackend, but
   * possibly several times per turn for StreamingTurnBackend (one per sentence, as each
   * is synthesized), alongside (before) each matching onReplyAudio call. Lets a host app
   * display what Vita said, not just hear it. */
  onReplyText(text: string): void;
  /** One chunk of synthesized reply audio; ConnectionRelay.speak() still owns chunking
   * it further for browser-facing playback -- see docs/BUILD_GUIDE.md plan notes on why
   * chunking stays there, not here. isFinalChunk marks the last chunk of the turn's
   * audio -- BatchTurnBackend always passes true (it only ever has one chunk);
   * StreamingTurnBackend passes it straight through from the orchestrator's own
   * turn.reply{final} signal. ConnectionRelay needs this to know when it's safe to
   * transition SPEAKING back to LISTENING (see relay.ts's speak()). */
  onReplyAudio(audio: Uint8Array, isFinalChunk: boolean): void;
  /** New/changed slot values (patient name, mobile, etc.) established this turn --
   * powers UI_FORM_AUTOFILL (see relay.ts's onFormAutofill). Optional, not required --
   * adding a required method here would break every existing TurnBackendEvents object
   * literal at compile time (same precedent as ReplyTextEvent.final in
   * packages/protocol/src/events.ts: an optional field/method lets an out-of-lockstep
   * implementation degrade gracefully instead of failing to compile). Fired at most once
   * per turn, only when there's something new. */
  onFormAutofill?(fields: Record<string, unknown>): void;
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
  /** Tells the backend to stop generating/synthesizing further reply chunks for the
   * turn currently in flight (a user barge-in). BatchTurnBackend is a no-op -- a batch
   * call has nothing in flight to abort by the time onReplyAudio could ever fire,
   * same accepted ISP tradeoff as endUtterance's unused fullAudio param above.
   * StreamingTurnBackend forwards it to the orchestrator over the same WS connection. */
  abortActiveTurn(): void;
  /** Call-teardown, mirrors ConnectionRelay.close()'s existing fire-and-forget pattern. */
  close(): void;
}

/** Identifies WHICH orchestrator session, and which generation of it, a backend speaks
 * for. Passed as one object rather than two positional params so the two values can't be
 * transposed at a call site, and so future per-connection identity has one place to live.
 * See OrchestratorSessionResult.epoch. */
export interface SessionHandle {
  sessionId: string;
  epoch: number;
}

export interface TurnBackendFactory {
  /** All connection setup, and the streaming-vs-batch fallback decision, happens here,
   * once, at call start. Never throws -- always resolves to *some* backend. */
  create(handle: SessionHandle, events: TurnBackendEvents): Promise<TurnBackend>;
}

/** Today's exact existing behavior (previously ConnectionRelay.endOfUtterance()'s HTTP-call
 * half), kept as a first-class fallback so a rejected/unavailable Sarvam realtime
 * connection degrades a call gracefully instead of failing it outright. */
export class BatchTurnBackend implements TurnBackend {
  constructor(
    private readonly orchestrator: OrchestratorClient,
    private readonly handle: SessionHandle,
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
    void this.orchestrator.postAudioTurn(this.handle.sessionId, this.handle.epoch, fullAudio).then(
      (result) => {
        if (!result.ok) {
          this.events.onError(result.error);
          return;
        }
        this.events.onFinalTranscript(result.data.transcript);
        // audioBase64/replyText are null iff transcript === '' (see TurnAudioResponse) --
        // possibly an empty string otherwise, which is still a real (silent) reply, not
        // "no reply".
        if (result.data.transcript.trim()) {
          this.events.onReplyText(result.data.replyText!);
          this.events.onReplyAudio(Buffer.from(result.data.audioBase64!, 'base64'), true);
        }
        if (result.data.formFields) {
          this.events.onFormAutofill?.(result.data.formFields);
        }
      },
      (err) => {
        this.events.onError({ code: 'BACKEND_FAILURE', message: String(err), recoverable: true });
      },
    );
  }

  abortActiveTurn(): void {
    // No-op -- postAudioTurn() above is a single request/response call; by the time
    // there's anything to abort, the reply has already been fully generated and sent.
  }

  close(): void {
    // Nothing to tear down -- postAudioTurn is a plain request/response call.
  }
}
