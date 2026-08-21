import { QdrantClient } from '@qdrant/js-client-rest';
import { BM25, type BM25Doc } from './bm25.js';

// Exported at the package boundary (not just used internally by HybridRetriever) so a
// consumer can build a sparse-only fallback of their own -- e.g. exactly the degraded
// path HybridRetriever.search() itself now falls back to internally when Qdrant/the
// embedder is unavailable, which a consumer outside this package previously couldn't
// replicate without reaching into internals bm25.ts's own doc comment already assumed
// were reusable ("small and dependency-free so it's trivially unit-testable").
export { BM25, type BM25Doc } from './bm25.js';
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
    const sparse = this.bm25.search(tokenize(query), topK * 2);

    let dense: { id: string; rank: number }[] = [];
    try {
      const queryVector = await this.embed(query);
      // Qdrant's older `.search()` was superseded by the universal `.query()`
      // endpoint (covers search/recommend/discover/hybrid in one call).
      const result = await this.qdrant.query(this.collection, {
        query: queryVector,
        limit: topK * 2,
      });
      dense = result.points.map((d, rank) => ({ id: String(d.id), rank }));
    } catch (err) {
      // Degrade to sparse-only rather than failing the whole search -- the BM25 half
      // above is already computed in-process (no network call at all), so a Qdrant
      // outage/timeout (or an embedding failure) shouldn't take down
      // search_vita_faq/search_hospital_reference entirely, just make results a bit
      // less precise until it recovers.
      console.error(
        JSON.stringify({
          type: 'HYBRID_RETRIEVER_DENSE_SEARCH_FAILED',
          collection: this.collection,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    const fused = reciprocalRankFusion(
      dense,
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
