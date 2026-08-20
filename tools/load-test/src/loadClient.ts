import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { BinaryFrameType, encodeBinaryFrame } from '@vita/protocol';
import type { CallRecord } from './metrics.js';
import { FRAME_SAMPLES } from './fixtures.js';

/**
 * One simulated caller's full life cycle over a REAL WS connection to the (real,
 * locally-running) gateway -- mirrors apps/gateway/test/wsRelay.integration.test.ts's
 * and wsResume.integration.test.ts's exact real-WS-client conventions (JWT mint ->
 * ticket POST -> WS connect with the ticket subprotocol -> binary/JSON frame dispatch),
 * generalized into a single reusable function instead of one-off test bodies.
 *
 * Deliberately one utterance per call (not a multi-turn conversation loop) -- a
 * realistic MVP ("is Dr Patel free" -> answer -> hang up) that keeps this harness
 * tractable; multi-turn is a documented possible future extension, not core scope.
 */

export interface SimulateCallConfig {
  callId: string;
  gatewayHttpUrl: string;
  jwtSecret: string;
  frames: Uint8Array[]; // raw PCM16 frames, FRAME_SAMPLES samples each
  /** Real-time cadence between frames -- 20ms matches this system's native frame rate.
   * Lower only for deliberately stress-testing faster-than-real-time bursts. */
  frameIntervalMs?: number;
  holdTimeMs?: number;
  /** Deadline for the whole call (ticket fetch through final close) -- a stuck call
   * must never hang the batch; exceeding this is recorded as a failure, not thrown. */
  timeoutMs?: number;
}

type SessionReadyMsg = { event: 'SESSION_READY'; sessionId: string; resumeToken: string; resumed: boolean };
type TranscriptMsg = { event: 'TRANSCRIPT'; text: string; is_final: boolean };
type StateChangeMsg = { event: 'STATE_CHANGE'; state: string };
type ServerMsg = SessionReadyMsg | TranscriptMsg | StateChangeMsg | { event: string; [key: string]: unknown };

export async function simulateCall(config: SimulateCallConfig): Promise<CallRecord> {
  const frameIntervalMs = config.frameIntervalMs ?? 20;
  const holdTimeMs = config.holdTimeMs ?? 500;
  const timeoutMs = config.timeoutMs ?? 15_000;

  const record: CallRecord = { callId: config.callId, success: false };
  const t0 = Date.now();

  try {
    await withTimeout(runCall(config, record, t0, frameIntervalMs, holdTimeMs), timeoutMs, `call ${config.callId} timed out`);
    record.success = true;
  } catch (err) {
    record.success = false;
    record.error = err instanceof Error ? err.message : String(err);
  }

  return record;
}

async function runCall(
  config: SimulateCallConfig,
  record: CallRecord,
  t0: number,
  frameIntervalMs: number,
  holdTimeMs: number,
): Promise<void> {
  const token = jwt.sign({ sub: `load-test-${config.callId}` }, config.jwtSecret);

  const ticketRes = await fetch(`${config.gatewayHttpUrl}/session/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!ticketRes.ok) throw new Error(`ticket fetch failed: ${ticketRes.status}`);
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  record.ticketLatencyMs = Date.now() - t0;

  const wsUrl = config.gatewayHttpUrl.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsUrl}/v1/stream`, [`vita-ticket.${ticket}`]);
  ws.binaryType = 'nodebuffer';

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    record.connectLatencyMs = Date.now() - t0;

    await waitForEvent(ws, 'SESSION_READY');
    record.sessionReadyLatencyMs = Date.now() - t0;

    for (const frame of config.frames) {
      ws.send(encodeBinaryFrame(BinaryFrameType.AUDIO_INPUT_PCM16, frame));
      await delay(frameIntervalMs);
    }

    await waitForFinalTranscript(ws);
    record.turnLatencyMs = Date.now() - t0;

    await waitForListening(ws);
    record.endToEndLatencyMs = Date.now() - t0;

    if (holdTimeMs > 0) await delay(holdTimeMs);
  } finally {
    ws.close();
  }
}

function waitForEvent(ws: WebSocket, eventName: string): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data.toString()) as ServerMsg;
      } catch {
        return;
      }
      if (msg.event === eventName) {
        cleanup();
        resolve(msg);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`socket closed before ${eventName}`));
    };
    function cleanup() {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

function waitForFinalTranscript(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data.toString()) as ServerMsg;
      } catch {
        return;
      }
      if (msg.event === 'TRANSCRIPT' && (msg as TranscriptMsg).is_final) {
        cleanup();
        resolve();
      } else if (msg.event === 'ERROR') {
        cleanup();
        reject(new Error(`server ERROR: ${JSON.stringify(msg)}`));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed before final transcript'));
    };
    function cleanup() {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

function waitForListening(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data.toString()) as ServerMsg;
      } catch {
        return;
      }
      if (msg.event === 'STATE_CHANGE' && (msg as StateChangeMsg).state === 'LISTENING') {
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed before returning to LISTENING'));
    };
    function cleanup() {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export { FRAME_SAMPLES };
