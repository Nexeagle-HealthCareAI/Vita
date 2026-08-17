import type { WebSocket } from 'ws';
import { BinaryFrameType, decodeBinaryFrame, encodeBinaryFrame } from '@vita/protocol';
import type { HmsClient } from '@vita/mcp-1hms';
import type { HybridRetriever } from '@vita/rag';
import type { SessionStore } from './session.js';
import type { BrainProvider } from './brain/types.js';
import type { StreamingSttSession } from './stt/types.js';
import type { TtsProvider } from './tts/types.js';
import { runTurn } from './pipeline.js';
import { recordAuditEvent } from './audit.js';
import type { ConnectionOpenGate } from './connectionGate.js';

/**
 * Internal gateway<->orchestrator control vocabulary for the streaming path -- the
 * orchestrator-side half of the same private, unversioned contract gateway's
 * orchestratorStreamClient.ts defines independently (see that file's comment for why
 * this deliberately isn't part of @vita/protocol).
 */
type GatewayStreamMessage = { event: 'speech_start' } | { event: 'speech_end' };
type OrchestratorStreamMessage =
  | { event: 'stream.ready' }
  | { event: 'stream.unavailable'; reason: string }
  | { event: 'transcript.partial'; text: string }
  | { event: 'transcript.final'; text: string }
  | { event: 'turn.reply'; text: string }
  | { event: 'turn.error'; code: string; message: string; recoverable: boolean };

export interface StreamSessionDeps {
  sessions: SessionStore;
  brain: BrainProvider;
  /** Used only for .synthesize() (TTS) inside runTurn -- entirely separate from
   * streamingSttSessionFactory below, which handles STT for this same call. */
  tts: TtsProvider;
  hms: HmsClient;
  retriever?: HybridRetriever;
  streamingSttSessionFactory: () => StreamingSttSession;
  connectionGate: ConnectionOpenGate;
  connectTimeoutMs: number;
  gateMaxWaitMs: number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

/** Mirrors ConnectionRelay's role on the gateway side: owns one call's worth of
 * streaming-STT orchestration -- opening (gated) the outbound Sarvam connection,
 * forwarding audio/speech-boundary signals to it, and turning a final transcript into
 * a reply via the exact same, unmodified runTurn the batch /turn/audio route uses. */
export class StreamSessionHandler {
  private sttSession: StreamingSttSession | undefined;
  private dead = false;

  constructor(
    private readonly sessionId: string,
    private readonly socket: WebSocket,
    private readonly deps: StreamSessionDeps,
  ) {}

  async init(): Promise<void> {
    try {
      await this.deps.connectionGate.acquire(this.deps.gateMaxWaitMs);
      const sttSession = this.deps.streamingSttSessionFactory();
      sttSession.onPartialTranscript((text) => this.sendJson({ event: 'transcript.partial', text }));
      sttSession.onFinalTranscript((text) => {
        void this.handleFinalTranscript(text);
      });
      sttSession.onFatal((reason) => this.handleFatal(reason));
      await sttSession.connect(this.deps.connectTimeoutMs);
      this.sttSession = sttSession;
      this.sendJson({ event: 'stream.ready' });
    } catch (err) {
      this.dead = true;
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn({ err: reason, sessionId: this.sessionId }, 'streamSession: Sarvam realtime unavailable, gateway should fall back to batch');
      this.sendJson({ event: 'stream.unavailable', reason });
    }
  }

  handleMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const { type, payload } = decodeBinaryFrame(new Uint8Array(data));
      if (type === BinaryFrameType.AUDIO_INPUT_PCM16) this.sttSession?.sendAudio(payload);
      return;
    }

    let msg: GatewayStreamMessage;
    try {
      msg = JSON.parse(data.toString()) as GatewayStreamMessage;
    } catch {
      return;
    }

    if (this.dead) {
      this.sendJson({
        event: 'turn.error',
        code: 'STREAMING_STT_UNAVAILABLE',
        message: 'streaming STT connection is unavailable for this call',
        recoverable: true,
      });
      return;
    }

    if (msg.event === 'speech_start') this.sttSession?.sendSpeechStart();
    if (msg.event === 'speech_end') this.sttSession?.sendSpeechEnd();
  }

  onClose(): void {
    this.sttSession?.end();
  }

  private async handleFinalTranscript(text: string): Promise<void> {
    const session = await this.deps.sessions.get(this.sessionId);
    if (!session) {
      this.sendJson({ event: 'turn.error', code: 'SESSION_NOT_FOUND', message: 'session not found', recoverable: false });
      return;
    }

    if (!text.trim()) {
      // Soft no-op, same convention as the batch /turn/audio route: manual endpointing
      // armed an utterance but Sarvam heard no words -- don't waste a Groq round trip.
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.role,
        action: 'stt_empty',
        outcome: 'success',
      });
      this.sendJson({ event: 'transcript.final', text: '' });
      return;
    }

    this.sendJson({ event: 'transcript.final', text });

    let result;
    try {
      result = await runTurn({
        session,
        transcript: text,
        brain: this.deps.brain,
        tts: this.deps.tts,
        hms: this.deps.hms,
        retriever: this.deps.retriever,
      });
    } catch (err) {
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.role,
        action: 'turn',
        outcome: 'error',
      });
      this.sendJson({
        event: 'turn.error',
        code: 'TURN_FAILED',
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      });
      return;
    }

    await this.deps.sessions.update(session.sessionId, { history: result.updatedHistory, turnState: 'IDLE' });
    this.sendJson({ event: 'turn.reply', text: result.replyText });
    this.socket.send(encodeBinaryFrame(BinaryFrameType.AUDIO_OUTPUT_PCM16, result.audio));
  }

  /** Sarvam dies mid-call (fatal error, or an unexpected close after session.begin) --
   * per the streaming STT plan, no reconnect is attempted for the rest of this call.
   * Every subsequent speech_start gets an immediate recoverable turn.error, same
   * failure philosophy already used for STT_FAILED/TURN_FAILED on the batch path. */
  private handleFatal(reason: string): void {
    this.dead = true;
    this.deps.log?.warn({ reason, sessionId: this.sessionId }, 'streamSession: Sarvam realtime session died mid-call');
    this.sendJson({ event: 'turn.error', code: 'STREAMING_STT_UNAVAILABLE', message: reason, recoverable: true });
  }

  private sendJson(msg: OrchestratorStreamMessage): void {
    this.socket.send(JSON.stringify(msg));
  }
}
