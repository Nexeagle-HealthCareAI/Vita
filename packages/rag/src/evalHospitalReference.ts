import { QdrantClient } from '@qdrant/js-client-rest';
import { LocalEmbedder } from './embedder.js';
import { HOSPITAL_REFERENCE_DOCS, referenceEmbedText } from './hospitalReferenceData.js';
import { HybridRetriever } from './index.js';

/**
 * Manual-only precision@5 eval for the hospital-reference corpus -- per
 * docs/BUILD_GUIDE.md §3.7's stated requirement. Not wired into vitest/CI: like
 * ingest.ts, it needs a real, already-ingested Qdrant plus a real embedding-model load,
 * and (unlike mcp-1hms-contract's nightly-CI pattern, which just calls an already-running
 * external service) automating this would need new CI infrastructure -- a Qdrant service
 * container plus an ingest step -- that doesn't exist yet. Deliberate, named deferral.
 *
 * Usage: pnpm --filter @vita/rag ingest   (once, to populate Qdrant)
 *        pnpm --filter @vita/rag eval
 */
const LABELED_QUERIES: { query: string; expectedSlug: string }[] = [
  { query: 'do I need to fast before a blood sugar test', expectedSlug: 'fasting-blood-glucose-lipid' },
  { query: 'what should I do to prepare for an ultrasound of the abdomen', expectedSlug: 'ultrasound-abdomen-prep' },
  { query: 'when should I stop eating before my surgery', expectedSlug: 'pre-operative-npo' },
  { query: 'can I wear jewelry for my MRI scan', expectedSlug: 'mri-prep' },
  { query: 'how do I prepare for a colonoscopy', expectedSlug: 'colonoscopy-prep' },
  { query: 'what time can I visit a patient in the ICU', expectedSlug: 'visiting-hours' },
  { query: 'what documents do I need to bring for an OPD appointment', expectedSlug: 'opd-registration-documents' },
  { query: 'what papers are required to admit a patient', expectedSlug: 'ipd-admission-documents' },
  { query: 'how long does discharge usually take', expectedSlug: 'discharge-process' },
  { query: 'how does a cashless insurance claim work at the hospital', expectedSlug: 'insurance-cashless-claim-basics' },
  { query: 'is an advance deposit required when a patient is admitted', expectedSlug: 'billing-advance-deposit-policy' },
  { query: 'who do I talk to if I have a complaint about my care', expectedSlug: 'patient-grievance-redressal' },
];

async function main(): Promise<void> {
  const client = new QdrantClient({
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined,
  });
  const embedder = new LocalEmbedder();
  const collection = process.env.QDRANT_HOSPITAL_REFERENCE_COLLECTION ?? 'vita_hospital_reference';
  const retriever = new HybridRetriever(client, collection, embedder.embed);
  retriever.indexCorpus(HOSPITAL_REFERENCE_DOCS.map((d) => ({ id: d.id, text: referenceEmbedText(d) })));

  const slugById = new Map(HOSPITAL_REFERENCE_DOCS.map((d) => [d.id, d.slug]));
  let hits = 0;

  for (const { query, expectedSlug } of LABELED_QUERIES) {
    const results = await retriever.search(query, 5);
    const foundSlugs = results.map((r) => slugById.get(r.id) ?? r.id);
    const pass = foundSlugs.includes(expectedSlug);
    if (pass) hits++;
    console.log(`[${pass ? 'PASS' : 'FAIL'}] "${query}" -> expected "${expectedSlug}", got [${foundSlugs.join(', ')}]`);
  }

  const precisionAt5 = hits / LABELED_QUERIES.length;
  console.log(`\nprecision@5: ${hits}/${LABELED_QUERIES.length} (${(precisionAt5 * 100).toFixed(0)}%)`);
}

main().catch((err) => {
  console.error('Eval failed:', err);
  process.exitCode = 1;
});
