import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/** Xenova/all-MiniLM-L6-v2: 384-dim sentence embeddings, small quantized ONNX model, pure
 * WASM inference -- no Python service, no API key, no network calls after the first model
 * download (cached under the package's node_modules by @huggingface/transformers itself). */
export const EMBEDDING_DIM = 384;
const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export class LocalEmbedder {
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  constructor(private readonly modelId: string = process.env.RAG_EMBED_MODEL ?? DEFAULT_MODEL_ID) {}

  private loadPipeline(): Promise<FeatureExtractionPipeline> {
    // Cache the load PROMISE (not just the resolved pipeline) so concurrent embed() calls
    // during a cold start share one load instead of racing multiple model downloads/inits.
    this.pipelinePromise ??= pipeline('feature-extraction', this.modelId);
    return this.pipelinePromise;
  }

  /** Arrow-function property (auto-bound) so this can be passed directly as
   * HybridRetriever's injected embed callback without a separate .bind(). */
  embed = async (text: string): Promise<number[]> => {
    const extractor = await this.loadPipeline();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    // .data is the flat underlying typed array regardless of whether the tensor's shape is
    // [384] or [1, 384] for a single-string input -- shape-agnostic.
    return Array.from(output.data as Float32Array);
  };
}
