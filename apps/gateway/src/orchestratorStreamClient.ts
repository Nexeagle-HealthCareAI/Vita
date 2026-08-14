import WebSocket from 'ws';
import { BinaryFrameType, decodeBinaryFrame, encodeBinaryFrame } from '@vita/protocol';

/**
 * Internal gateway<->orchestrator control vocabulary for the real-time streaming path.
 * Deliberately NOT part of @vita/protocol -- these two apps are always built from the
 * same commit and deployed together (docker-compose.prod.yml), never independently
 * versioned or exposed to an external consumer, so packages/protocol's
 * PROTOCOL_VERSION ceremony (which exists for the browser<->gateway contract's
 * independent-client compatibility, e.g. the Phase 2 mobile SDK) doesn't apply here.
 * Matches the existing precedent: today's /session and /turn/audio HTTP contract
 * between these same two apps is already two independent, unshared type definitions.
 */
type OrchestratorStreamMessage =
  | { event: 'stream.ready' }
  | { event: 'stream.unavailable'; reason: string }
  | { event: 'transcript.partial'; text: string }
  | { event: 'transcript.final'; text: string }
  | { event: 'turn.error'; code: string; message: string; recoverable: boolean };

export interface OrchestratorStreamCallbacks {
  onPartialTranscript(text: string): void;
  onFinalTranscript(text: string): void;
  onReplyAudio(audio: Uint8Array): void;
  onTurnError(code: string, message: string, recoverable: boolean): void;
  /** Fires on any close/error *after* a successful connect -- never for the initial
   * connect-failure case, which connect() itself resolves as 'unavailable' instead. */
  onDisconnected(): void;
}

export type StreamConnectOutcome = 'ready' | 'unavailable';

// Same constructor-injected-transport pattern as every other client in this codebase
// (AudioPreprocessClient, OrchestratorClient's fetchImpl) -- lets tests supply a fake
// WebSocket implementation without a real socket.
export class OrchestratorStreamClient {
  private socket: WebSocket | undefined;
  private callbacks: OrchestratorStreamCallbacks | undefined;
  private connected = false;

  constructor(
    private readonly baseWsUrl: string,
    private readonly wsImpl: typeof WebSocket = WebSocket,
  ) {}

  connect(sessionId: string, timeoutMs: number, callbacks: OrchestratorStreamCallbacks): Promise<StreamConnectOutcome> {
    this.callbacks = callbacks;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: StreamConnectOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const timer = setTimeout(() => settle('unavailable'), timeoutMs);

      const socket = new this.wsImpl(`${this.baseWsUrl}/session/${encodeURIComponent(sessionId)}/stream`);
      this.socket = socket;
      socket.binaryType = 'nodebuffer';

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          const { type, payload } = decodeBinaryFrame(new Uint8Array(data));
          if (type === BinaryFrameType.AUDIO_OUTPUT_PCM16) this.callbacks?.onReplyAudio(payload);
          return;
        }
        const msg = JSON.parse(data.toString()) as OrchestratorStreamMessage;
        switch (msg.event) {
          case 'stream.ready':
            this.connected = true;
            settle('ready');
            break;
          case 'stream.unavailable':
            settle('unavailable');
            break;
          case 'transcript.partial':
            this.callbacks?.onPartialTranscript(msg.text);
            break;
          case 'transcript.final':
            this.callbacks?.onFinalTranscript(msg.text);
            break;
          case 'turn.error':
            this.callbacks?.onTurnError(msg.code, msg.message, msg.recoverable);
            break;
        }
      });

      socket.on('close', () => {
        settle('unavailable'); // no-op if already settled 'ready'
        if (this.connected) {
          this.connected = false;
          this.callbacks?.onDisconnected();
        }
      });

      socket.on('error', () => {
        settle('unavailable'); // 'close' follows and fires onDisconnected if we'd connected
      });
    });
  }

  sendSpeechStart(): void {
    this.socket?.send(JSON.stringify({ event: 'speech_start' }));
  }

  sendSpeechEnd(): void {
    this.socket?.send(JSON.stringify({ event: 'speech_end' }));
  }

  sendAudioFrame(frame: Uint8Array): void {
    this.socket?.send(encodeBinaryFrame(BinaryFrameType.AUDIO_INPUT_PCM16, frame));
  }

  close(): void {
    this.socket?.close();
  }
}
