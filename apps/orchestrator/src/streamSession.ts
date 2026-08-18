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
type GatewayStreamMessage = { event: 'speech_start' } | { event: 'speech_end' } | { event: 'turn.abort' };
type OrchestratorStreamMessage =
  | { event: 'stream.ready' }
  | { event: 'stream.unavailable'; reason: string }
  | { event: 'transcript.partial'; text: string }
  | { event: 'transcript.final'; text: string }
  /** final:false for every sentence chunk but the last, so the gateway/client know when a
   * turn's spoken reply is genuinely done -- see pipeline.ts's runTurn's onReplyChunk. */
  | { event: 'turn.reply'; text: string; final: boolean }
  /** Sent at most once per turn, and only when something actually changed -- see
   * pipeline.ts's slot-tracking (slots.ts) and this file's handleFinalTranscript(). Only
   * ever sent for a ROLE_RECEPTIONIST session (role-gated in handleFinalTranscript, the
   * authoritative check -- see index.ts's computeFormFields for the HTTP-route twin of
   * this same gate). */
  | { event: 'turn.form_autofill'; data: Record<string, unknown> }
  | { event: 'turn.error'; code: string; message: string; recoverable: boolean };

export interface StreamSessionDeps {
  sessions: SessionStore;
  brain: BrainProvider;
  /** Used only for .synthesize() (TTS) inside runTurn -- entirely separate from
   * streamingSttSessionFactory below, which handles STT for this same call. */
  tts: TtsProvider;
  hms: HmsClient;
  faqRetriever?: HybridRetriever;
  hospitalReferenceRetriever?: HybridRetriever;
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
  /** Set by an inbound turn.abort (the gateway's ConnectionRelay sends this when the user
   * barges in mid-reply) and checked by runTurn between rounds, so a barge-in stops
   * further generation/synthesis instead of wastefully continuing a reply nobody's
   * listening to anymore. Reset at the start of every new turn. */
  private turnAborted = false;

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
    if (msg.event === 'turn.abort') this.turnAborted = true;
  }

  onClose(): void {
    this.sttSession?.end();
  }

  private async handleFinalTranscript(text: string): Promise<void> {
    this.turnAborted = false; // a fresh turn always starts un-aborted, even if a barge-in fired on the PREVIOUS one

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
        faqRetriever: this.deps.faqRetriever,
        hospitalReferenceRetriever: this.deps.hospitalReferenceRetriever,
        // Sends each sentence's text+audio as soon as it's synthesized, instead of
        // waiting for the whole reply -- text message immediately followed by its own
        // binary audio frame, in that order, for every chunk including the last. That
        // ordering is load-bearing: the gateway correlates a turn.reply{final} message
        // with the very next binary frame to know which chunk ends the turn's audio
        // (see orchestratorStreamClient.ts).
        onReplyChunk: (chunk) => {
          this.sendJson({ event: 'turn.reply', text: chunk.text, final: chunk.isFinal });
          this.socket.send(encodeBinaryFrame(BinaryFrameType.AUDIO_OUTPUT_PCM16, chunk.audio));
        },
        isAborted: () => this.turnAborted,
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

    // Persist whatever was actually said even if a mid-stream TTS failure (result.error)
    // cut the reply short -- runTurn already guarantees history/replyText/audio reflect
    // only what was truly spoken, never more. The chunks themselves were already sent
    // live via onReplyChunk above; only the error (if any) still needs surfacing.
    // Role-gated HERE, orchestrator-side, as the authoritative check -- see index.ts's
    // computeFormFields doc comment for why (a ROLE_DOCTOR session never sends/audits a
    // push at all, rather than relying on a downstream gate to drop it silently).
    // result.formFieldsThisTurn is pipeline.ts's own high-water-mark diff -- see
    // RunTurnResult's doc comment for why it's not simply session.slots vs. updatedSlots.
    const formFields = session.role === 'ROLE_RECEPTIONIST' ? result.formFieldsThisTurn : {};
    await this.deps.sessions.update(session.sessionId, { history: result.updatedHistory, slots: result.updatedSlots, turnState: 'IDLE' });
    if (Object.keys(formFields).length > 0) {
      this.sendJson({ event: 'turn.form_autofill', data: formFields });
      recordAuditEvent({
        ts: Date.now(),
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.role,
        action: 'form_autofill_push',
        outcome: 'success',
      });
    }
    if (result.error) {
      this.sendJson({ event: 'turn.error', code: 'TTS_FAILED', message: result.error, recoverable: true });
    }
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
