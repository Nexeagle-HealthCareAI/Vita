import { BinaryFrameType, decodeBinaryFrame, encodeBinaryFrame, PROTOCOL_VERSION, ServerControlEvent } from '@vita/protocol';
import { JitterBufferPlayer } from './playback.js';
import { computeRmsLevel } from './audioLevel.js';

export type TeraState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR';

/** Patient/booking fields pushed via UI_FORM_AUTOFILL -- named to match what the
 * orchestrator actually sends: raw tool-call argument names (see
 * apps/orchestrator/src/tools.ts's TOOL_SCHEMAS), not a separately-invented naming
 * scheme, so there's no translation layer anywhere in the pipeline. Extend as 1HMS
 * grows; the index signature already forwards any other slot the orchestrator starts
 * tracking (doctorId, preferredTime, reason, city, ...) even before it's named here. */
export interface PatientFormFields {
  patientName?: string;
  patientMobile?: string;
  specialtyCategory?: string;
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
  /** The assistant's reply for a turn, as text -- may now fire multiple times per turn
   * (one per sentence, as each is synthesized) instead of exactly once; `isFinal`
   * distinguishes "more of this reply is still coming" from "this is the last piece".
   * Each call still fires independently of (and before) the AUDIO_OUTPUT_PCM16 binary
   * frame that carries that same piece's spoken audio. */
  onReplyText?: (text: string, isFinal: boolean) => void;
  onFormAutofill?: (fields: PatientFormFields) => void;
  /** Local-only amplitude meter for the outgoing microphone audio, fired ~50/sec
   * (once per 20ms frame), roughly 0-1 -- purely for UI feedback (e.g. a bouncing
   * mic-level indicator). Never sent to the server, and has ZERO influence on
   * turn-taking/barge-in -- those remain entirely the server's Silero VAD's job (see
   * apps/audio-preprocess), which stays the single source of truth. See
   * audioLevel.ts's computeRmsLevel for what's actually computed. */
  onAudioLevel?: (level: number) => void;
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
  /** Bumped by every startSession() call and by stopSession() -- the single source of
   * truth for "is this specific in-flight start/connect attempt still the one in charge."
   * Each async step below (post-fetchTicket, post-WS-open, post-initAudioCapture) captures
   * the generation current at its OWN call's start and re-checks it after every await,
   * bailing out (never touching this.ws, never opening the mic) if a stopSession() or a
   * newer startSession() superseded it in the meantime. Without this, stopSession() firing
   * while a ticket fetch (or the mic-permission prompt) was in flight would tear the
   * connection down correctly, only for the stale call to resolve afterward and silently
   * reconnect / re-open the mic anyway -- overriding the user's just-revoked consent. */
  private connectGeneration = 0;
  private ticketFetchAbort: AbortController | null = null;

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
    const generation = ++this.connectGeneration;
    const abort = new AbortController();
    this.ticketFetchAbort = abort;
    try {
      const ticket = await this.fetchTicket(abort.signal);
      if (generation !== this.connectGeneration) return; // superseded by a stop/restart while the fetch was in flight
      this.connect(ticket, generation);
    } catch (err) {
      if (abort.signal.aborted || generation !== this.connectGeneration) return; // stopSession() caused this rejection, not a real failure
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
  private async fetchTicket(signal: AbortSignal): Promise<string> {
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
      signal,
    });
    if (!res.ok) {
      throw new Error(`ticket exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { ticket: string };
    return body.ticket;
  }

  private connect(ticket: string, generation: number): void {
    const wsUrl = this.config.gatewayOrigin.replace(/^http/, 'ws');
    // Short-lived, single-use ticket passed as a WS subprotocol rather than a
    // query-string token — it's still visible to the immediate proxy hop but
    // expires in seconds and can only be redeemed once, unlike a raw JWT.
    // Captured in a local (not read back via this.ws) so a stale/superseded connection's
    // own handlers below always act on the socket THEY opened, never on whatever
    // this.ws happens to point at by the time they run (which may since be a newer one).
    const socket = new WebSocket(`${wsUrl}/v1/stream`, [`vita-ticket.${ticket}`]);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = async () => {
      if (generation !== this.connectGeneration) {
        // stopSession() (or a newer startSession()) fired while the WS handshake was in
        // flight -- this socket is already stale. Close it directly rather than never
        // touching it, and return before ever sending HELLO or prompting for the mic.
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      // Sent unconditionally, regardless of whether the gateway's
      // PROTOCOL_VERSION_ENFORCEMENT_ENABLED kill-switch is on -- so flipping enforcement
      // on later needs no coordinated client redeploy. Synchronous, before the mic-permission
      // dependent initAudioCapture() below, to give the gateway's grace-period timer the best
      // realistic chance of seeing this before any audio frame (not a strict guarantee).
      socket.send(JSON.stringify({ event: 'HELLO', version: PROTOCOL_VERSION, role: this.config.userRole }));
      this.setState('LISTENING');
      try {
        await this.initAudioCapture();
      } catch (err) {
        this.emitError('AUDIO_CAPTURE_FAILED', err, /* recoverable */ false);
        this.setState('ERROR');
        return;
      }
      if (generation !== this.connectGeneration) {
        // stopSession() fired while getUserMedia()/AudioWorklet setup was itself in
        // flight (that permission prompt can take an arbitrary amount of real time) --
        // don't leave a mic freshly opened under a session that's already been torn down.
        this.teardownAudio();
        socket.close();
      }
    };

    socket.onmessage = (event) => this.handleMessage(event);

    socket.onerror = () => {
      this.emitError('SOCKET_ERROR', new Error('WebSocket error'), /* recoverable */ true);
    };

    socket.onclose = (event) => {
      // Checked BEFORE teardownAudio(), not after -- a superseded (stale) generation's
      // close must never tear down a NEWER generation's already-live mic/AudioContext (a
      // fast stop-then-restart can leave this stale close firing after the new one is up).
      if (generation !== this.connectGeneration) return;
      this.teardownAudio();
      if (this.userInitiatedStop || this.torn_down) {
        this.setState('IDLE');
        return;
      }
      if (event.code === 4003) {
        // Gateway rejected this connection for missing/unsupported protocol version
        // (PROTOCOL_VERSION_ENFORCEMENT_ENABLED) -- retrying with the same client build
        // will deterministically fail again, so don't scheduleReconnect() into a loop.
        this.setState('ERROR');
        this.emitError(
          'UNSUPPORTED_PROTOCOL_VERSION',
          new Error('gateway rejected this connection: unsupported protocol version'),
          /* recoverable */ false,
        );
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      return; // ignore malformed frames rather than throwing on a hot path
    }
    // Runtime-validated against the real wire schema, not just cast to it -- @vita/protocol
    // exports ServerControlEvent as a zod schema specifically for this. A malformed/drifted
    // payload (a field renamed on one side but not the other, an unexpected type) previously
    // sailed through untyped and could crash a host app that trusted the declared TS shape
    // (e.g. calling .trim() on a `text` that was actually undefined) -- now it's dropped the
    // same way a JSON.parse failure already is, one line above.
    const result = ServerControlEvent.safeParse(parsed);
    if (!result.success) return;
    const msg = result.data;

    switch (msg.event) {
      case 'TRANSCRIPT':
        this.config.onTranscript?.(msg.text, msg.is_final);
        break;
      case 'REPLY_TEXT':
        // final is optional on the wire (see ReplyTextEvent's doc comment in
        // @vita/protocol) -- default true so a sender that omits it still reads as "one
        // complete reply" rather than leaving a host app's UI waiting indefinitely for a
        // final chunk that will never come.
        this.config.onReplyText?.(msg.text, msg.final ?? true);
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
      const buffer = event.data as ArrayBuffer;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encodeBinaryFrame(BinaryFrameType.AUDIO_INPUT_PCM16, new Uint8Array(buffer)));
      }
      // Purely local UI feedback, computed from the same frame already sent above --
      // this can never gate whether/when audio is sent, since it only runs after that
      // decision has already been made (see onAudioLevel's doc comment on TeraConfig).
      this.config.onAudioLevel?.(computeRmsLevel(new Int16Array(buffer)));
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
    // Invalidates any startSession()/connect() currently in flight -- see
    // connectGeneration's own doc comment for why this is what actually prevents the mic
    // from silently re-activating after this explicit stop.
    this.connectGeneration++;
    this.ticketFetchAbort?.abort();
    this.ticketFetchAbort = null;
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
