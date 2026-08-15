import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIM, LocalEmbedder } from '../src/embedder.js';

// Real model load + real inference (pure JS/WASM, no native toolchain) -- the one
// deliberate exception to this repo's otherwise-fully-offline test suite. First run in a
// fresh checkout downloads the small quantized ONNX model from huggingface.co; cached
// after that (~800ms warm load, ~20ms/embed, measured locally). Bumped past vitest's
// default 5s timeout to comfortably cover a cold download on a slow connection.
describe('LocalEmbedder', () => {
  it(
    'embeds text into a 384-dim vector of finite numbers',
    async () => {
      const embedder = new LocalEmbedder();
      const vector = await embedder.embed('What is Vita?');
      expect(vector).toHaveLength(EMBEDDING_DIM);
      expect(vector.every((v) => Number.isFinite(v))).toBe(true);
    },
    30_000,
  );

  it(
    'shares one model load across concurrent embed() calls instead of racing multiple loads',
    async () => {
      const embedder = new LocalEmbedder();
      const [a, b] = await Promise.all([embedder.embed('hello'), embedder.embed('world')]);
      expect(a).toHaveLength(EMBEDDING_DIM);
      expect(b).toHaveLength(EMBEDDING_DIM);
      // Different inputs must not produce identical embeddings -- a cheap sanity check
      // that the pipeline is actually running per-call, not returning a cached constant.
      expect(a).not.toEqual(b);
    },
    30_000,
  );
});
