import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JitterBufferPlayer } from '../src/playback.js';

class FakeAudioBufferSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn(() => {
    this.onended?.();
  });
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, copyToChannel: vi.fn() };
  }
  createBufferSource() {
    return new FakeAudioBufferSourceNode();
  }
}

describe('JitterBufferPlayer', () => {
  let ctx: FakeAudioContext;
  let player: JitterBufferPlayer;

  beforeEach(() => {
    ctx = new FakeAudioContext();
    player = new JitterBufferPlayer(ctx as unknown as AudioContext);
  });

  it('schedules chunks back-to-back without gaps', () => {
    const chunkA = new Int16Array([100, 200, 300]);
    const chunkB = new Int16Array([400, 500]);

    player.enqueue(chunkA, 16000);
    const firstDuration = chunkA.length / 16000;

    player.enqueue(chunkB, 16000);

    // internal nextStartTime should have advanced by the first chunk's duration
    expect((player as unknown as { nextStartTime: number }).nextStartTime).toBeCloseTo(
      firstDuration + chunkB.length / 16000,
    );
  });

  it('flush() stops all active sources and resets the schedule', () => {
    player.enqueue(new Int16Array([1, 2, 3]), 16000);
    player.flush();
    expect((player as unknown as { activeSources: unknown[] }).activeSources).toHaveLength(0);
  });
});
