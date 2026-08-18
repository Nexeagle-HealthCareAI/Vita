import { QdrantClient } from '@qdrant/js-client-rest';
import { BM25, type BM25Doc } from './bm25.js';

export { LocalEmbedder, EMBEDDING_DIM } from './embedder.js';
export { FAQ_DOCS, faqEmbedText, type FaqDoc } from './faqData.js';
export { HOSPITAL_REFERENCE_DOCS, referenceEmbedText, type ReferenceDoc } from './hospitalReferenceData.js';

export interface HybridSearchResult {
  id: string;
  text: string;
  score: number;
}

/**
 * Hybrid retriever: dense similarity from Qdrant + sparse BM25, combined by
 * reciprocal rank fusion. Embedding generation (the `embed` callback) is
 * injected so tests don't need a real embedding model or network call.
 */
export class HybridRetriever {
  private bm25 = new BM25();
  private corpus = new Map<string, string>();

  constructor(
    private qdrant: QdrantClient,
    private collection: string,
    private embed: (text: string) => Promise<number[]>,
  ) {}

  indexCorpus(docs: { id: string; text: string }[]): void {
    this.corpus = new Map(docs.map((d) => [d.id, d.text]));
    const bm25Docs: BM25Doc[] = docs.map((d) => ({ id: d.id, tokens: tokenize(d.text) }));
    this.bm25.index(bm25Docs);
  }

  async search(query: string, topK = 5): Promise<HybridSearchResult[]> {
    const queryVector = await this.embed(query);
    // Qdrant's older `.search()` was superseded by the universal `.query()`
    // endpoint (covers search/recommend/discover/hybrid in one call).
    const dense = await this.qdrant.query(this.collection, {
      query: queryVector,
      limit: topK * 2,
    });
    const sparse = this.bm25.search(tokenize(query), topK * 2);

    const fused = reciprocalRankFusion(
      dense.points.map((d, rank) => ({ id: String(d.id), rank })),
      sparse.map((s, rank) => ({ id: s.id, rank })),
    );

    return fused.slice(0, topK).map(({ id, score }) => ({
      id,
      text: this.corpus.get(id) ?? '',
      score,
    }));
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function reciprocalRankFusion(
  a: { id: string; rank: number }[],
  b: { id: string; rank: number }[],
  k = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const { id, rank } of [...a, ...b]) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((x, y) => y.score - x.score);
}
