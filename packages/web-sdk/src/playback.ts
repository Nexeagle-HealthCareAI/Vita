/**
 * Scheduled jitter-buffer playback queue.
 *
 * Fixes the v1.0 stub (`playAudioChunk` was a bare comment). Chunks arrive
 * over the network with jitter; naively calling `source.start()` on arrival
 * produces audible gaps/overlaps. Instead we schedule each chunk against
 * `audioContext.currentTime`, chaining start times so playback is gapless
 * as long as chunks arrive faster than they're consumed.
 */
export class JitterBufferPlayer {
  private ctx: AudioContext;
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** Enqueue a PCM16 mono chunk (16kHz) for gapless playback. */
  enqueue(pcm16: Int16Array, sampleRate = 16000): void {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      const sample = pcm16[i] ?? 0;
      float32[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
    }

    const buffer = this.ctx.createBuffer(1, float32.length, sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.push(source);
    source.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== source);
    };
  }

  /** Immediately stop everything — called on CLEAR_PLAYBACK (barge-in). */
  flush(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // already stopped; ignore
      }
    }
    this.activeSources = [];
    this.nextStartTime = this.ctx.currentTime;
  }
}
