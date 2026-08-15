/**
 * Hand-written FAQ corpus about Vita itself (not the original architecture's larger
 * lab-rules/insurance-doc corpus -- that stays future work, see docs/BUILD_GUIDE.md §3.7).
 *
 * `id` must be a valid Qdrant point id (unsigned int or UUID string -- arbitrary strings
 * like "what-is-vita" are rejected at upsert time). Since this is a small, static, hand-
 * written list rather than a growing corpus, each id is just a literal UUID generated once
 * (crypto.randomUUID()) rather than derived -- `slug` is the human-readable identifier used
 * in logs/tests/Qdrant payloads.
 */
export interface FaqDoc {
  id: string;
  slug: string;
  question: string;
  answer: string;
}

export const FAQ_DOCS: FaqDoc[] = [
  {
    id: '4c2fe3dd-5965-4445-af7c-6e069d55970e',
    slug: 'what-is-vita',
    question: 'What is Vita?',
    answer: 'Vita is a voice assistant built for hospital reception and doctor counters, part of the 1HMS platform.',
  },
  {
    id: 'b3a1aa40-d1aa-4cff-b75d-5cd2d2b7fd93',
    slug: 'what-can-it-do',
    question: 'What can Vita do?',
    answer:
      'Vita can find doctors by specialty, department, city, or name; check whether a specific doctor is working on a given date; and log a preferred-time appointment request for a patient.',
  },
  {
    id: 'b29f608f-5b8f-495e-bbf8-1249ad96e9da',
    slug: 'where-hosted',
    question: 'Where is Vita hosted?',
    answer:
      'Vita runs on self-hosted infrastructure on E2E Networks in India, chosen to keep data in-region for DPDPA, ABDM, and MeitY compliance.',
  },
  {
    id: '95304add-2130-4406-be6d-1064c3b7ed4f',
    slug: 'who-built-why',
    question: 'Who built Vita, and why?',
    answer:
      'Vita is built by Nexeagle to help hospital front-desk staff and doctors handle routine voice interactions, like booking requests and availability checks, faster and with less manual entry.',
  },
  {
    id: '73efc0b9-0794-43f7-9cf1-0a7efd4dfee7',
    slug: 'languages',
    question: 'What languages does Vita understand?',
    answer:
      "Vita's speech recognition and voice replies are powered by Sarvam AI, configured for Indian English (en-IN) by default, with Hindi and Hinglish supported by the underlying models.",
  },
  {
    id: 'b4d96a96-d185-42c1-85cc-86be873e934e',
    slug: 'bookings-final',
    question: 'Are bookings made through Vita final?',
    answer:
      'No -- an appointment made through Vita is a non-binding request. Hospital staff confirm the exact time with the patient afterward.',
  },
  {
    id: '7bb7f180-39b0-401d-8ced-a932d0bdacbc',
    slug: 'replaces-staff',
    question: 'Does Vita replace front-desk staff?',
    answer:
      'No -- Vita handles routine voice tasks like booking requests and availability checks so front-desk staff can focus on things that need a person.',
  },
  {
    id: '51a011a5-517f-477f-80fd-5833ab65cc03',
    slug: 'doctors-can-use',
    question: 'Can doctors use Vita too?',
    answer:
      'Yes -- doctors have their own role in Vita, separate from receptionists, with access scoped to what a doctor needs.',
  },
  {
    id: 'a35be849-d6e6-4eb3-bb5e-830ea082ef10',
    slug: 'how-do-i-start',
    question: 'How do I start talking to Vita?',
    answer:
      "There's no wake word -- Vita starts listening as soon as a voice session connects, and you can just talk normally.",
  },
  {
    id: '6c622642-a931-48d9-b7fb-41d84557a785',
    slug: 'what-is-1hms',
    question: 'What is 1HMS?',
    answer: '1HMS is the hospital management system Vita is built on top of -- Vita is its voice interface for reception and doctor-facing tasks.',
  },
];

/** Text embedded/indexed per doc -- used identically by both indexCorpus()'s BM25 half
 * (in-process, at orchestrator boot) and ingest.ts's dense/Qdrant half, so the two halves
 * of hybrid search are always built from the same source text. */
export function faqEmbedText(doc: FaqDoc): string {
  return `${doc.question}\n${doc.answer}`;
}
