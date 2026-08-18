import { QdrantClient } from '@qdrant/js-client-rest';
import { EMBEDDING_DIM, LocalEmbedder } from './embedder.js';
import { FAQ_DOCS, faqEmbedText } from './faqData.js';
import { HOSPITAL_REFERENCE_DOCS, referenceEmbedText } from './hospitalReferenceData.js';

/**
 * One-shot ingestion script for both corpora's dense/Qdrant half (the BM25 half of each
 * is rebuilt cheaply in-process at orchestrator boot from the same doc arrays -- see
 * apps/orchestrator/src/index.ts). Idempotent: every doc's `id` is a fixed literal UUID
 * (see faqData.ts / hospitalReferenceData.ts), so re-running this always upserts in
 * place rather than duplicating.
 *
 * Usage: pnpm --filter @vita/rag ingest  (requires QDRANT_URL reachable, e.g.
 * `docker compose up -d qdrant` from the repo root first).
 */
async function ensureCollectionAndUpsert(
  client: QdrantClient,
  collection: string,
  points: { id: string; vector: number[]; payload: Record<string, unknown> }[],
): Promise<void> {
  const { exists } = await client.collectionExists(collection);
  if (!exists) {
    await client.createCollection(collection, { vectors: { size: EMBEDDING_DIM, distance: 'Cosine' } });
    console.log(`Created Qdrant collection "${collection}" (${EMBEDDING_DIM}-dim, cosine).`);
  }
  await client.upsert(collection, { wait: true, points });
  console.log(`Upserted ${points.length} docs into "${collection}".`);
}

async function main(): Promise<void> {
  const client = new QdrantClient({
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined,
  });
  const embedder = new LocalEmbedder();

  const faqPoints = [];
  for (const doc of FAQ_DOCS) {
    const vector = await embedder.embed(faqEmbedText(doc));
    faqPoints.push({ id: doc.id, vector, payload: { slug: doc.slug, question: doc.question, answer: doc.answer } });
  }
  await ensureCollectionAndUpsert(client, process.env.QDRANT_FAQ_COLLECTION ?? 'vita_faq', faqPoints);

  const referencePoints = [];
  for (const doc of HOSPITAL_REFERENCE_DOCS) {
    const vector = await embedder.embed(referenceEmbedText(doc));
    referencePoints.push({
      id: doc.id,
      vector,
      payload: { slug: doc.slug, title: doc.title, category: doc.category, body: doc.body },
    });
  }
  await ensureCollectionAndUpsert(
    client,
    process.env.QDRANT_HOSPITAL_REFERENCE_COLLECTION ?? 'vita_hospital_reference',
    referencePoints,
  );
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exitCode = 1;
});
