import { QdrantClient } from '@qdrant/js-client-rest';
import { EMBEDDING_DIM, LocalEmbedder } from './embedder.js';
import { FAQ_DOCS, faqEmbedText } from './faqData.js';

/**
 * One-shot ingestion script for the FAQ corpus's dense/Qdrant half (the BM25 half is
 * rebuilt cheaply in-process at orchestrator boot from the same FAQ_DOCS -- see
 * apps/orchestrator/src/index.ts). Idempotent: every doc's `id` is a fixed literal UUID
 * (see faqData.ts), so re-running this always upserts in place rather than duplicating.
 *
 * Usage: pnpm --filter @vita/rag ingest  (requires QDRANT_URL reachable, e.g.
 * `docker compose up -d qdrant` from the repo root first).
 */
async function main(): Promise<void> {
  const collection = process.env.QDRANT_FAQ_COLLECTION ?? 'vita_faq';
  const client = new QdrantClient({
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined,
  });
  const embedder = new LocalEmbedder();

  const { exists } = await client.collectionExists(collection);
  if (!exists) {
    await client.createCollection(collection, { vectors: { size: EMBEDDING_DIM, distance: 'Cosine' } });
    console.log(`Created Qdrant collection "${collection}" (${EMBEDDING_DIM}-dim, cosine).`);
  }

  const points = [];
  for (const doc of FAQ_DOCS) {
    const vector = await embedder.embed(faqEmbedText(doc));
    points.push({ id: doc.id, vector, payload: { slug: doc.slug, question: doc.question, answer: doc.answer } });
  }
  await client.upsert(collection, { wait: true, points });
  console.log(`Upserted ${points.length} FAQ docs into "${collection}".`);
}

main().catch((err) => {
  console.error('FAQ ingest failed:', err);
  process.exitCode = 1;
});
