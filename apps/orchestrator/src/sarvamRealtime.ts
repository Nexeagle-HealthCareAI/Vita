import WebSocket from 'ws';

/**
 * Wraps one outbound WebSocket connection to Sarvam's realtime STT API
 * (saaras:v3-realtime) for the duration of one call. Wire protocol verified directly
 * against docs.sarvam.ai during planning (connection URL, query params, message
 * shapes, close codes) -- see the streaming STT plan for the full reference. Uses
 * `endpointing=manual`, driven entirely by the gateway's already-shipped local Silero
 * VAD state machine (apps/audio-preprocess/app/vad.py) rather than Sarvam's own `vad`
 * mode, so there's a single authority for turn-taking, not two that can disagree.
 *
 * Same constructor-injected-transport pattern as every other client in this codebase
 * (SarvamClient's fetchImpl, AudioPreprocessClient, ...) -- wsImpl lets tests supply a
 * fake WebSocket implementation without a real socket.
 */
export class SarvamRealtimeSession {
  private socket: WebSocket | undefined;
  private ready = false;
  private partialHandler: ((text: string) => void) | undefined;
  private finalHandler: ((text: string) => void) | undefined;
  private fatalHandler: ((reason: string) => void) | undefined;

  constructor(
    private readonly connectUrl: string,
    private readonly apiKey: string,
    private readonly wsImpl: typeof WebSocket = WebSocket,
  ) {}

  onPartialTranscript(cb: (text: string) => void): void {
    this.partialHandler = cb;
  }

  onFinalTranscript(cb: (text: string) => void): void {
    this.finalHandler = cb;
  }

  /** is_fatal:true, or a close/error before ever reaching session.begin (surfaced via
   * connect()'s rejection instead -- not double-reported here), or an unexpected
   * close/error *after* session.begin (mid-call disconnect). */
  onFatal(cb: (reason: string) => void): void {
    this.fatalHandler = cb;
  }

  connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Sarvam realtime connect timed out'));
      }, timeoutMs);

      // API-SUBSCRIPTION-KEY as a connect header, never in the URL -- same
      // "credentials shouldn't land in access/proxy logs" precedent already
      // established for the browser ticket flow (docs/ARCHITECTURE.md item 1).
      const socket = new this.wsImpl(this.connectUrl, { headers: { 'API-SUBSCRIPTION-KEY': this.apiKey } });
      this.socket = socket;
      socket.binaryType = 'nodebuffer';

      socket.on('message', (data: Buffer) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        switch (msg.event) {
          case 'session.begin':
            this.ready = true;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
            break;
          case 'transcript.partial':
            this.partialHandler?.(typeof msg.text === 'string' ? msg.text : '');
            break;
          case 'transcript.final':
            this.finalHandler?.(typeof msg.text === 'string' ? msg.text : '');
            break;
          case 'error':
            // Non-fatal errors (e.g. invalid_config) leave the connection alive per
            // Sarvam's docs -- only is_fatal:true is a real failure worth surfacing.
            if (msg.is_fatal === true) {
              this.fatalHandler?.(typeof msg.message === 'string' ? msg.message : String(msg.code ?? 'unknown error'));
            }
            break;
          // session.end is informational only -- the 'close' handler below does the
          // actual teardown signaling.
        }
      });

      socket.on('close', (code: number, reason: Buffer) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Sarvam realtime closed before ready: code=${code} reason=${reason?.toString()}`));
          return;
        }
        if (this.ready) {
          this.fatalHandler?.(`connection closed unexpectedly: code=${code} reason=${reason?.toString()}`);
        }
      });

      socket.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        if (this.ready) {
          this.fatalHandler?.(err.message);
        }
      });
    });
  }

  sendSpeechStart(): void {
    this.socket?.send(JSON.stringify({ event: 'speech_start' }));
  }

  sendSpeechEnd(): void {
    this.socket?.send(JSON.stringify({ event: 'speech_end' }));
  }

  sendAudio(frame: Uint8Array): void {
    this.socket?.send(JSON.stringify({ event: 'audio_input', audio: Buffer.from(frame).toString('base64') }));
  }

  end(): void {
    this.socket?.send(JSON.stringify({ event: 'end' }));
    this.socket?.close();
  }
}

export interface SarvamRealtimeUrlConfig {
  baseUrl: string; // e.g. wss://api.sarvam.ai/speech-to-text-realtime/ws
  languageCode: string;
  streamType: string;
}

/** Builds the full connect URL with the query params verified against Sarvam's real
 * docs -- a pure function, kept separate from SarvamRealtimeSession itself so it's
 * trivially unit-testable without touching WebSocket at all. */
export function buildSarvamRealtimeUrl(config: SarvamRealtimeUrlConfig): string {
  const params = new URLSearchParams({
    language_code: config.languageCode,
    model: 'saaras:v3-realtime',
    stream_type: config.streamType,
    mode: 'transcribe',
    endpointing: 'manual',
    encoding: 'linear16',
    sample_rate: '16000',
  });
  return `${config.baseUrl}?${params.toString()}`;
}
