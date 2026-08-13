/**
 * Minimal BM25 scorer for the sparse half of hybrid search. Small and
 * dependency-free so it's trivially unit-testable; swap for a proper
 * inverted-index implementation (or Qdrant's built-in sparse vectors) once
 * the corpus grows past what an in-memory scorer can handle.
 */
export interface BM25Doc {
  id: string;
  tokens: string[];
}

export class BM25 {
  private docs: BM25Doc[] = [];
  private avgDocLen = 0;
  private df = new Map<string, number>();
  private k1 = 1.5;
  private b = 0.75;

  index(docs: BM25Doc[]): void {
    this.docs = docs;
    this.avgDocLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / (docs.length || 1);
    this.df.clear();
    for (const doc of docs) {
      const seen = new Set(doc.tokens);
      for (const term of seen) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  score(query: string[], doc: BM25Doc): number {
    let score = 0;
    for (const term of query) {
      const tf = doc.tokens.filter((t) => t === term).length;
      if (tf === 0) continue;
      const idf = this.idf(term);
      const norm = tf * (this.k1 + 1);
      const denom = tf + this.k1 * (1 - this.b + (this.b * doc.tokens.length) / this.avgDocLen);
      score += idf * (norm / denom);
    }
    return score;
  }

  search(query: string[], topK = 5): { id: string; score: number }[] {
    return this.docs
      .map((doc) => ({ id: doc.id, score: this.score(query, doc) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
