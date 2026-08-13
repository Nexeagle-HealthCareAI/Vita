import { describe, expect, it } from 'vitest';
import { BM25 } from '../src/bm25.js';

describe('BM25', () => {
  it('ranks the doc containing the query term higher', () => {
    const bm25 = new BM25();
    bm25.index([
      { id: 'a', tokens: ['fasting', 'lipid', 'profile', 'requires', '12', 'hour', 'fast'] },
      { id: 'b', tokens: ['insurance', 'claim', 'form', 'requires', 'signature'] },
    ]);

    const results = bm25.search(['fasting', 'requires']);
    expect(results[0]?.id).toBe('a');
  });
});
