import { describe, expect, it, vi } from 'vitest';
import { DefaultTurnBackendFactory } from '../src/streamingTurnBackend.js';
import { BatchTurnBackend, type TurnBackendEvents } from '../src/turnBackend.js';
import { OrchestratorClient } from '../src/orchestratorClient.js';
import type { OrchestratorStreamClient, StreamConnectOutcome } from '../src/orchestratorStreamClient.js';

function fakeOrchestrator() {
  return Object.create(OrchestratorClient.prototype) as OrchestratorClient;
}

function fakeEvents(): TurnBackendEvents {
  return {
    onPartialTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onReplyText: vi.fn(),
    onReplyAudio: vi.fn(),
    onFormAutofill: vi.fn(),
    onError: vi.fn(),
  };
}

function fakeStreamClient(outcome: StreamConnectOutcome) {
  return {
    connect: vi.fn().mockResolvedValue(outcome),
    sendSpeechStart: vi.fn(),
    sendSpeechEnd: vi.fn(),
    sendAudioFrame: vi.fn(),
    close: vi.fn(),
  } as unknown as OrchestratorStreamClient;
}

describe('DefaultTurnBackendFactory', () => {
  it('STREAMING_STT_ENABLED=false: always returns a BatchTurnBackend immediately, never attempting a stream connect', async () => {
    const streamClientFactory = vi.fn();
    const factory = new DefaultTurnBackendFactory(fakeOrchestrator(), streamClientFactory, {
      streamingEnabled: false,
      connectTimeoutMs: 1000,
    });

    const backend = await factory.create('sess-1', fakeEvents());

    expect(backend).toBeInstanceOf(BatchTurnBackend);
    expect(streamClientFactory).not.toHaveBeenCalled();
  });

  it('streaming enabled + connect succeeds: returns the streaming backend, not batch', async () => {
    const stream = fakeStreamClient('ready');
    const factory = new DefaultTurnBackendFactory(fakeOrchestrator(), () => stream, {
      streamingEnabled: true,
      connectTimeoutMs: 1000,
    });

    const backend = await factory.create('sess-1', fakeEvents());

    expect(backend).not.toBeInstanceOf(BatchTurnBackend);
    expect(stream.connect).toHaveBeenCalledWith('sess-1', 1000, expect.any(Object));
    expect(stream.close).not.toHaveBeenCalled();
  });

  it('streaming enabled + connect resolves "unavailable": falls back to BatchTurnBackend and tears down the failed stream socket', async () => {
    const stream = fakeStreamClient('unavailable');
    const factory = new DefaultTurnBackendFactory(fakeOrchestrator(), () => stream, {
      streamingEnabled: true,
      connectTimeoutMs: 1000,
    });

    const backend = await factory.create('sess-1', fakeEvents());

    expect(backend).toBeInstanceOf(BatchTurnBackend);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('decides once per call: create() is not re-invoked or re-evaluated by the backend it returns', async () => {
    // Sanity check on the "decided once, never re-evaluated mid-call" contract: the
    // returned backend holds no reference back to the factory, so nothing downstream can
    // trigger a second create() call for the same session.
    const stream = fakeStreamClient('ready');
    const streamClientFactory = vi.fn(() => stream);
    const factory = new DefaultTurnBackendFactory(fakeOrchestrator(), streamClientFactory, {
      streamingEnabled: true,
      connectTimeoutMs: 1000,
    });

    await factory.create('sess-1', fakeEvents());
    expect(streamClientFactory).toHaveBeenCalledTimes(1);
  });
});
