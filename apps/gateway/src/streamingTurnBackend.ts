import { BatchTurnBackend, type TurnBackend, type TurnBackendEvents, type TurnBackendFactory } from './turnBackend.js';
import { OrchestratorStreamClient } from './orchestratorStreamClient.js';
import type { OrchestratorClient } from './orchestratorClient.js';

const STREAM_DISCONNECTED_ERROR = {
  code: 'STREAM_DISCONNECTED',
  message: 'streaming STT connection lost',
  recoverable: true,
} as const;

/**
 * Forwards every frame ConnectionRelay decides belongs to the accumulating utterance to
 * the orchestrator in real time, instead of buffering it locally. A small explicit state
 * machine (accumulating/awaitingResult/dead) exists specifically to avoid hangs on a
 * mid-call disconnect -- see the disconnect-timing table in the streaming STT plan for
 * the four scenarios this resolves.
 */
export class StreamingTurnBackend implements TurnBackend {
  private accumulating = false;
  private awaitingResult = false;
  private dead = false;

  constructor(
    private readonly stream: OrchestratorStreamClient,
    private readonly events: TurnBackendEvents,
  ) {}

  beginUtterance(): void {
    if (this.dead) {
      this.events.onError(STREAM_DISCONNECTED_ERROR);
      return;
    }
    this.accumulating = true;
    this.stream.sendSpeechStart();
  }

  pushFrame(frame: Uint8Array): void {
    if (!this.accumulating || this.dead) return;
    this.stream.sendAudioFrame(frame);
  }

  endUtterance(): void {
    if (!this.accumulating) {
      // maxUtteranceMs's safety valve can fire before beginUtterance() ever ran (it
      // doesn't require `armed`) -- nothing was ever pushed to Sarvam, so this is a
      // network-call-free equivalent of today's soft no-op.
      this.events.onFinalTranscript('');
      return;
    }
    this.accumulating = false;
    if (this.dead) {
      this.events.onError(STREAM_DISCONNECTED_ERROR);
      return;
    }
    this.awaitingResult = true;
    this.stream.sendSpeechEnd();
  }

  close(): void {
    this.stream.close();
  }

  // -- Wired as OrchestratorStreamClient callbacks by the factory below --

  handlePartialTranscript(text: string): void {
    this.events.onPartialTranscript(text);
  }

  handleFinalTranscript(text: string): void {
    this.awaitingResult = false;
    this.events.onFinalTranscript(text);
  }

  handleReplyAudio(audio: Uint8Array): void {
    this.events.onReplyAudio(audio);
  }

  handleTurnError(code: string, message: string, recoverable: boolean): void {
    this.awaitingResult = false;
    this.events.onError({ code, message, recoverable });
  }

  handleDisconnected(): void {
    this.dead = true;
    if (this.awaitingResult) {
      this.awaitingResult = false;
      this.events.onError(STREAM_DISCONNECTED_ERROR);
    }
    // Idle, or mid-utterance-before-endUtterance: stay silent here -- the next
    // beginUtterance()/endUtterance() call already checks `dead` and surfaces the error
    // tied to that actual user action, instead of firing while the caller is silent.
  }
}

export interface TurnBackendFactoryConfig {
  streamingEnabled: boolean;
  connectTimeoutMs: number;
}

/** Decides once per call, at ConnectionRelay.start() time, whether this call gets the
 * real-time streaming backend or falls back to the existing batch one -- never
 * re-evaluated mid-call (no complex pipeline-switching state during an active
 * conversation). streamClientFactory is injected so tests can supply a fake WS
 * transport without a real socket, matching this codebase's DI-for-testability
 * convention. */
export class DefaultTurnBackendFactory implements TurnBackendFactory {
  constructor(
    private readonly orchestrator: OrchestratorClient,
    private readonly streamClientFactory: () => OrchestratorStreamClient,
    private readonly config: TurnBackendFactoryConfig,
  ) {}

  async create(sessionId: string, events: TurnBackendEvents): Promise<TurnBackend> {
    if (!this.config.streamingEnabled) {
      return new BatchTurnBackend(this.orchestrator, sessionId, events);
    }

    const stream = this.streamClientFactory();
    const backend = new StreamingTurnBackend(stream, events);
    const outcome = await stream.connect(sessionId, this.config.connectTimeoutMs, {
      onPartialTranscript: (text) => backend.handlePartialTranscript(text),
      onFinalTranscript: (text) => backend.handleFinalTranscript(text),
      onReplyAudio: (audio) => backend.handleReplyAudio(audio),
      onTurnError: (code, message, recoverable) => backend.handleTurnError(code, message, recoverable),
      onDisconnected: () => backend.handleDisconnected(),
    });

    if (outcome === 'unavailable') {
      stream.close();
      return new BatchTurnBackend(this.orchestrator, sessionId, events);
    }
    return backend;
  }
}

export { OrchestratorStreamClient };
