// Plain JS on purpose: AudioWorkletProcessor modules run in a separate
// worklet global scope and are loaded via audioContext.audioWorklet.addModule(),
// which does not go through the app's normal TS/bundler pipeline.
// This file is copied into dist/ as-is by the build script (see package.json).

class TeraPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._frameSize = 320; // 20ms @ 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0]; // Float32Array, mono

    for (let i = 0; i < channel.length; i++) {
      this._buffer.push(channel[i]);
    }

    while (this._buffer.length >= this._frameSize) {
      const frame = this._buffer.splice(0, this._frameSize);
      const pcm16 = new Int16Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Transfer the underlying buffer — zero-copy to the main thread.
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('tera-pcm-processor', TeraPcmProcessor);
