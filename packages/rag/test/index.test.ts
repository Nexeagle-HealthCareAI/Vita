import { describe, expect, it, vi } from 'vitest';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { HybridRetriever } from '../src/index.js';

function fakeQdrant(points: { id: string; score: number }[]): QdrantClient {
  return { query: vi.fn().mockResolvedValue({ points }) } as unknown as QdrantClient;
}

describe('HybridRetriever', () => {
  it('fuses dense (Qdrant) and sparse (BM25) rankings and resolves ids back to indexed text', async () => {
    const qdrant = fakeQdrant([
      { id: 'doc-1', score: 0.9 },
      { id: 'doc-2', score: 0.5 },
    ]);
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const retriever = new HybridRetriever(qdrant, 'test-collection', embed);

    retriever.indexCorpus([
      { id: 'doc-1', text: 'What is Vita? Vita is a voice assistant.' },
      { id: 'doc-2', text: 'Where is Vita hosted? On E2E Networks.' },
    ]);

    const results = await retriever.search('what is vita', 5);

    expect(embed).toHaveBeenCalledWith('what is vita');
    expect(qdrant.query).toHaveBeenCalledWith('test-collection', { query: [0.1, 0.2, 0.3], limit: 10 });
    expect(results.map((r) => r.id)).toContain('doc-1');
    expect(results.find((r) => r.id === 'doc-1')?.text).toBe('What is Vita? Vita is a voice assistant.');
  });

  it('returns an empty result set when nothing is indexed and Qdrant has nothing to return', async () => {
    const qdrant = fakeQdrant([]);
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const retriever = new HybridRetriever(qdrant, 'test-collection', embed);

    const results = await retriever.search('anything', 5);

    expect(results).toEqual([]);
  });
});
