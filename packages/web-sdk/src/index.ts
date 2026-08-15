import { BinaryFrameType, decodeBinaryFrame, encodeBinaryFrame } from '@vita/protocol';
import type { ServerControlEvent } from '@vita/protocol';
import { JitterBufferPlayer } from './playback.js';

export type TeraState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR';

/** Patient registration fields pushed via UI_FORM_AUTOFILL. Extend as 1HMS grows. */
export interface PatientFormFields {
  patient_name?: string;
  phone?: string;
  department?: string;
  [key: string]: unknown;
}

export interface TeraConfig {
  /** Base HTTPS origin, e.g. "https://gateway.vita.hospital" — used for ticket exchange and derived into wss:// for the stream. */
  gatewayOrigin: string;
  /** Long-lived user JWT. Sent ONLY over HTTPS to /session/ticket — never placed in the WS URL. */
  authToken: string;
  /** Advisory only — the server derives the real role from the JWT. Used purely for local UX gating (e.g. hiding autofill UI). */
  userRole: 'ROLE_RECEPTIONIST' | 'ROLE_DOCTOR';
  /** Override path to the AudioWorklet module if you're not using the SDK's bundled asset. */
  workletUrl?: string | URL;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onFormAutofill?: (fields: PatientFormFields) => void;
  onStateChange?: (state: TeraState) => void;
  onError?: (error: { code: string; message: string; recoverable: boolean }) => void;
  /** Fires on every SESSION_READY (i.e. every successful connect, fresh or resumed) with
   * whether this connect reused a prior conversation. Lets a host app decide e.g. whether
   * to clear a displayed transcript log on a fresh session vs. leave it in place on a
   * resumed one -- the only way to observe the outcome SESSION_RESUME actually produces. */
  onSessionResumed?: (resumed: boolean) => void;
}

const MAX_RECONNECT_DELAY_MS = 15_000;

export class TeraWebSDK {
  private config: TeraConfig;
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private player: JitterBufferPlayer | null = null;
  private reconnectAttempt = 0;
  private userInitiatedStop = false;
  private torn_down = false;
  // Held in memory only (not persisted across a page reload -- matches "WiFi blip", not
  // "user refreshed the tab") so a reconnect can ask the gateway to reattach to the same
  // orchestrator session instead of silently starting a fresh one. Populated from
  // SESSION_READY; cleared on an explicit stopSession() so a deliberate hangup can never
  // be resumed afterward.
  private resumeSessionId: string | null = null;
  private resumeToken: string | null = null;
  // Set only past startSession()'s consent guard; read by fetchTicket() (so the gateway/
  // orchestrator can audit it) and by scheduleReconnect() (so an automatic reconnect of an
  // already-consented session doesn't silently downgrade to no-consent). Reset on
  // stopSession() -- a fresh explicit start must re-assert consent, same as resumeToken.
  private consentGiven = false;

  constructor(config: TeraConfig) {
    this.config = config;
  }

  /** consentGiven is required (no default) so every call site -- including future ones --
   * has to make an explicit choice rather than silently starting without it. False blocks
   * the call entirely: no ticket fetch, no WS, no mic prompt. */
  public async startSession(consentGiven: boolean): Promise<void> {
    if (!consentGiven) {
      this.emitError('CONSENT_REQUIRED', new Error('startSession() called without user consent'), /* recoverable */ false);
      return;
    }
    this.consentGiven = true;
    this.userInitiatedStop = false;
    this.torn_down = false;
    try {
      const ticket = await this.fetchTicket();
      this.connect(ticket);
    } catch (err) {
      this.emitError('TICKET_FETCH_FAILED', err, /* recoverable */ true);
      this.scheduleReconnect();
    }
  }

  /** Ticket exchange happens over HTTPS so the long-lived JWT never touches the WS URL or
   * proxy logs -- a held resume pair rides the same HTTPS-protected body, for the same
   * reason (see docs/ARCHITECTURE.md's SESSION_RESUME notes). Only sent if BOTH fields are
   * held; the gateway treats an absent/incomplete pair as "start a fresh session," so an
   * old/unmodified SDK build (which never sends either field) is unaffected. consentGiven
   * is always true here (startSession()'s guard already returned otherwise) -- sent
   * explicitly so the gateway/orchestrator have a real value to audit rather than assuming. */
  private async fetchTicket(): Promise<string> {
    const requestBody: { resumeSessionId?: string; resumeToken?: string; consentGiven: boolean } = {
      consentGiven: this.consentGiven,
    };
    if (this.resumeSessionId && this.resumeToken) {
      requestBody.resumeSessionId = this.resumeSessionId;
      requestBody.resumeToken = this.resumeToken;
    }
    const res = await fetch(`${this.config.gatewayOrigin}/session/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      throw new Error(`ticket exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { ticket: string };
    return body.ticket;
  }

  private connect(ticket: string): void {
    const wsUrl = this.config.gatewayOrigin.replace(/^http/, 'ws');
    // Short-lived, single-use ticket passed as a WS subprotocol rather than a
    // query-string token — it's still visible to the immediate proxy hop but
    // expires in seconds and can only be redeemed once, unlike a raw JWT.
    this.ws = new WebSocket(`${wsUrl}/v1/stream`, [`vita-ticket.${ticket}`]);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = async () => {
      this.reconnectAttempt = 0;
      this.setState('LISTENING');
      try {
        await this.initAudioCapture();
      } catch (err) {
        this.emitError('AUDIO_CAPTURE_FAILED', err, /* recoverable */ false);
        this.setState('ERROR');
      }
    };

    this.ws.onmessage = (event) => this.handleMessage(event);

    this.ws.onerror = () => {
      this.emitError('SOCKET_ERROR', new Error('WebSocket error'), /* recoverable */ true);
    };

    this.ws.onclose = (event) => {
      this.teardownAudio();
      if (this.userInitiatedStop || this.torn_down) {
        this.setState('IDLE');
        return;
      }
      // Unexpected close (network drop, auth expiry) — reconnect with backoff
      // instead of leaving the session dead.
      this.setState('ERROR');
      this.emitError(
        'CONNECTION_LOST',
        new Error(`socket closed unexpectedly (code ${event.code})`),
        /* recoverable */ true,
      );
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.userInitiatedStop || this.torn_down) return;
    const delay = Math.min(2 ** this.reconnectAttempt * 500, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt++;
    setTimeout(() => {
      if (this.userInitiatedStop || this.torn_down) return;
      void this.startSession(this.consentGiven);
    }, delay);
  }

  private handleMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      const { type, payload } = decodeBinaryFrame(new Uint8Array(event.data));
      if (type === BinaryFrameType.AUDIO_OUTPUT_PCM16 && this.player) {
        const pcm16 = new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2);
        this.player.enqueue(pcm16);
        this.setState('SPEAKING');
      }
      return;
    }

    let msg: ServerControlEvent;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return; // ignore malformed frames rather than throwing on a hot path
    }

    switch (msg.event) {
      case 'TRANSCRIPT':
        this.config.onTranscript?.(msg.text, msg.is_final);
        break;
      case 'UI_FORM_AUTOFILL':
        if (this.config.userRole === 'ROLE_RECEPTIONIST') {
          this.config.onFormAutofill?.(msg.data as PatientFormFields);
        }
        break;
      case 'CLEAR_PLAYBACK':
        // Barge-in: stop whatever's currently scheduled immediately.
        this.player?.flush();
        this.setState('LISTENING');
        break;
      case 'STATE_CHANGE':
        this.setState(msg.state);
        break;
      case 'ERROR':
        this.config.onError?.(msg);
        break;
      case 'SESSION_READY':
        this.resumeSessionId = msg.sessionId;
        this.resumeToken = msg.resumeToken;
        this.config.onSessionResumed?.(msg.resumed);
        break;
    }
  }

  private async initAudioCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Single AEC: rely on the browser's native implementation.
        // Do NOT also run a custom WASM AEC in front of this — running two
        // AEC engines in series fights the same echo path and degrades quality.
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
    });
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.player = new JitterBufferPlayer(this.audioContext);

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    const workletUrl = this.config.workletUrl ?? new URL('./tera-pcm-processor.js', import.meta.url);
    await this.audioContext.audioWorklet.addModule(workletUrl);
    const pcmWorker = new AudioWorkletNode(this.audioContext, 'tera-pcm-processor');

    pcmWorker.port.onmessage = (event) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const frame = encodeBinaryFrame(
          BinaryFrameType.AUDIO_INPUT_PCM16,
          new Uint8Array(event.data as ArrayBuffer),
        );
        this.ws.send(frame);
      }
    };
    source.connect(pcmWorker);
  }

  private teardownAudio(): void {
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.player = null;
  }

  /** Idempotent — safe to call multiple times (e.g. once from the UI, once from onclose). */
  public stopSession(): void {
    if (this.torn_down) return;
    this.torn_down = true;
    this.userInitiatedStop = true;
    this.resumeSessionId = null;
    this.resumeToken = null; // an explicit hangup must never be resumable afterward
    this.consentGiven = false; // a fresh explicit start must re-assert consent
    this.teardownAudio();
    this.ws?.close();
    this.ws = null;
    this.setState('IDLE');
  }

  private setState(state: TeraState): void {
    this.config.onStateChange?.(state);
  }

  private emitError(code: string, err: unknown, recoverable: boolean): void {
    const message = err instanceof Error ? err.message : String(err);
    this.config.onError?.({ code, message, recoverable });
  }
}

export { TeraWebSDK as VitaWebSDK };
export type { TeraConfig as VitaConfig, TeraState as VitaState };

export { JitterBufferPlayer } from './playback.js';
