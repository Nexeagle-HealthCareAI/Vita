import { describe, expect, it } from 'vitest';
import { HOSPITAL_REFERENCE_DOCS, referenceEmbedText } from '../src/hospitalReferenceData.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('HOSPITAL_REFERENCE_DOCS', () => {
  it('is non-empty', () => {
    expect(HOSPITAL_REFERENCE_DOCS.length).toBeGreaterThan(0);
  });

  it('every doc has a valid UUID id (Qdrant point-id constraint)', () => {
    for (const doc of HOSPITAL_REFERENCE_DOCS) {
      expect(doc.id).toMatch(UUID_RE);
    }
  });

  it('every id is unique', () => {
    const ids = HOSPITAL_REFERENCE_DOCS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every slug is unique', () => {
    const slugs = HOSPITAL_REFERENCE_DOCS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every doc has a non-empty title and body', () => {
    for (const doc of HOSPITAL_REFERENCE_DOCS) {
      expect(doc.title.trim().length).toBeGreaterThan(0);
      expect(doc.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('every doc has a valid category', () => {
    for (const doc of HOSPITAL_REFERENCE_DOCS) {
      expect(['clinical_prep', 'hospital_policy']).toContain(doc.category);
    }
  });

  it('referenceEmbedText combines title and body', () => {
    const doc = HOSPITAL_REFERENCE_DOCS[0]!;
    expect(referenceEmbedText(doc)).toBe(`${doc.title}\n${doc.body}`);
  });
});
