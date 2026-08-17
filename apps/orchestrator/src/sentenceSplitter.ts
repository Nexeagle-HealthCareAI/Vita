/**
 * Splits a growing text buffer into complete sentences as they form, for streaming
 * synthesis (pipeline.ts speaks each sentence as soon as it's ready instead of waiting
 * for the whole reply). This is deliberately narrow: it only prevents WRONG sentence
 * *boundaries* (e.g. treating "Dr." as the end of a sentence) -- it never rewrites or
 * expands text. Converting abbreviations/numbers to spoken form for pronunciation (the
 * separately-tracked "phonetic normalization" item) is a different concern and stays
 * out of this file.
 */

// Case-sensitive: only the exact capitalized form is treated as an abbreviation, so a
// sentence that genuinely ends in a lowercase "st." (rare, but not "St." the honorific)
// isn't misclassified.
const ABBREVIATIONS = new Set(['Dr.', 'Mr.', 'Mrs.', 'Ms.', 'St.', 'vs.', 'etc.', 'approx.', 'e.g.', 'i.e.']);

function endsWithAbbreviation(textUpToAndIncludingPeriod: string): boolean {
  const lastWordMatch = /(\S+)$/.exec(textUpToAndIncludingPeriod);
  const lastWord = lastWordMatch?.[1];
  return lastWord !== undefined && ABBREVIATIONS.has(lastWord);
}

/**
 * Scans `buffer` for complete sentences ending in ". "/"! "/"? ", skipping boundaries
 * that land right after a known abbreviation. Deliberately requires REAL trailing
 * whitespace, not just "punctuation at the current end of the buffer" -- since this
 * buffer grows incrementally as tokens stream in, a period at the tail might just be a
 * chunk boundary mid-decimal ("The dose is 2." with "5 mg" still to arrive), not a real
 * sentence end. The final, possibly-unterminated remainder is the caller's (pipeline.ts's)
 * job to flush once the stream itself ends, not this function's. Each returned sentence
 * retains its own original trailing whitespace/punctuation exactly as it appeared in
 * `buffer`, so concatenating `complete` (in order) followed by `remainder` always
 * reconstructs `buffer` exactly -- callers never need to insert their own spacing.
 */
export function splitCompletedSentences(buffer: string): { complete: string[]; remainder: string } {
  const complete: string[] = [];
  let searchFrom = 0;
  let sentenceStart = 0;

  while (searchFrom < buffer.length) {
    const match = /[.!?]\s+/.exec(buffer.slice(searchFrom));
    if (!match) break;

    const boundaryEnd = searchFrom + match.index + match[0].length;
    const sentenceCandidate = buffer.slice(sentenceStart, boundaryEnd);

    if (buffer[searchFrom + match.index] === '.' && endsWithAbbreviation(buffer.slice(sentenceStart, searchFrom + match.index + 1))) {
      // Not a real sentence boundary -- keep scanning from just past this period.
      searchFrom = searchFrom + match.index + 1;
      continue;
    }

    complete.push(sentenceCandidate);
    sentenceStart = boundaryEnd;
    searchFrom = boundaryEnd;
  }

  return { complete, remainder: buffer.slice(sentenceStart) };
}
