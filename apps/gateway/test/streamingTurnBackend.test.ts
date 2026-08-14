import { describe, expect, it, vi } from 'vitest';
import { StreamingTurnBackend } from '../src/streamingTurnBackend.js';
import type { OrchestratorStreamClient } from '../src/orchestratorStreamClient.js';
import type { TurnBackendEvents } from '../src/turnBackend.js';

const STREAM_DISCONNECTED_ERROR = { code: 'STREAM_DISCONNECTED', message: 'streaming STT connection lost', recoverable: true };

function fakeStream() {
  return {
    sendSpeechStart: vi.fn(),
    sendSpeechEnd: vi.fn(),
    sendAudioFrame: vi.fn(),
    close: vi.fn(),
  } as unknown as OrchestratorStreamClient;
}

function fakeEvents(): TurnBackendEvents {
  return {
    onPartialTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onReplyAudio: vi.fn(),
    onError: vi.fn(),
  };
}

describe('StreamingTurnBackend', () => {
  it('beginUtterance() sends speech_start and pushFrame() forwards frames while accumulating', () => {
    const stream = fakeStream();
    const backend = new StreamingTurnBackend(stream, fakeEvents());

    backend.beginUtterance();
    expect(stream.sendSpeechStart).toHaveBeenCalledTimes(1);

    backend.pushFrame(new Uint8Array([1, 2]));
    expect(stream.sendAudioFrame).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  });

  it('pushFrame() before beginUtterance() is a no-op (nothing accumulating yet)', () => {
    const stream = fakeStream();
    const backend = new StreamingTurnBackend(stream, fakeEvents());

    backend.pushFrame(new Uint8Array([1]));
    expect(stream.sendAudioFrame).not.toHaveBeenCalled();
  });

  it('endUtterance() when never armed (maxUtteranceMs fired pre-beginUtterance) is a network-call-free soft no-op', () => {
    const stream = fakeStream();
    const events = fakeEvents();
    const backend = new StreamingTurnBackend(stream, events);

    backend.endUtterance();

    expect(stream.sendSpeechEnd).not.toHaveBeenCalled();
    expect(events.onFinalTranscript).toHaveBeenCalledWith('');
  });

  it('endUtterance() after beginUtterance() sends speech_end and awaits a result', () => {
    const stream = fakeStream();
    const events = fakeEvents();
    const backend = new StreamingTurnBackend(stream, events);

    backend.beginUtterance();
    backend.endUtterance();

    expect(stream.sendSpeechEnd).toHaveBeenCalledTimes(1);
    expect(events.onFinalTranscript).not.toHaveBeenCalled(); // no result yet

    backend.handleFinalTranscript('hello');
    expect(events.onFinalTranscript).toHaveBeenCalledWith('hello');
  });

  it('handlePartialTranscript/handleReplyAudio/handleTurnError route straight through to events', () => {
    const stream = fakeStream();
    const events = fakeEvents();
    const backend = new StreamingTurnBackend(stream, events);

    backend.handlePartialTranscript('hel');
    expect(events.onPartialTranscript).toHaveBeenCalledWith('hel');

    backend.handleReplyAudio(new Uint8Array([9]));
    expect(events.onReplyAudio).toHaveBeenCalledWith(new Uint8Array([9]));

    backend.handleTurnError('TURN_FAILED', 'boom', true);
    expect(events.onError).toHaveBeenCalledWith({ code: 'TURN_FAILED', message: 'boom', recoverable: true });
  });

  it('close() delegates to the stream client', () => {
    const stream = fakeStream();
    const backend = new StreamingTurnBackend(stream, fakeEvents());

    backend.close();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  describe('disconnect-timing scenarios (mid-call hang prevention)', () => {
    it('scenario 1: disconnect while idle (no utterance in flight) is silent -- dead, but no onError fires', () => {
      const stream = fakeStream();
      const events = fakeEvents();
      const backend = new StreamingTurnBackend(stream, events);

      backend.handleDisconnected();

      expect(events.onError).not.toHaveBeenCalled();
    });

    it('scenario 2: the next beginUtterance() after a dead disconnect surfaces an immediate recoverable error', () => {
      const stream = fakeStream();
      const events = fakeEvents();
      const backend = new StreamingTurnBackend(stream, events);

      backend.handleDisconnected();
      backend.beginUtterance();

      expect(events.onError).toHaveBeenCalledWith(STREAM_DISCONNECTED_ERROR);
      expect(stream.sendSpeechStart).not.toHaveBeenCalled(); // never resurrects a dead link
    });

    it('scenario 3: a disconnect mid-utterance (before endUtterance()) is surfaced at endUtterance() time, not sent as a doomed speech_end', () => {
      const stream = fakeStream();
      const events = fakeEvents();
      const backend = new StreamingTurnBackend(stream, events);

      backend.beginUtterance();
      backend.handleDisconnected(); // dies mid-utterance, before endUtterance() is ever called
      expect(events.onError).not.toHaveBeenCalled(); // silent while the caller is still mid-utterance

      backend.endUtterance();
      expect(stream.sendSpeechEnd).not.toHaveBeenCalled();
      expect(events.onError).toHaveBeenCalledWith(STREAM_DISCONNECTED_ERROR);
    });

    it('scenario 4: a disconnect after speech_end was sent but before a result arrives is surfaced immediately', () => {
      const stream = fakeStream();
      const events = fakeEvents();
      const backend = new StreamingTurnBackend(stream, events);

      backend.beginUtterance();
      backend.endUtterance(); // awaitingResult = true
      expect(stream.sendSpeechEnd).toHaveBeenCalledTimes(1);

      backend.handleDisconnected();

      expect(events.onError).toHaveBeenCalledWith(STREAM_DISCONNECTED_ERROR);
    });
  });
});
