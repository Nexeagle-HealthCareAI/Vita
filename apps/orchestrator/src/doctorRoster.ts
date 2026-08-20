import type { HmsClient, RosterDoctor } from '@vita/mcp-1hms';

// Generous ceiling on how many doctors get formatted into the system prompt -- a one-line-
// per-doctor list stays well under a meaningful token budget even at this size; revisit only
// if a real deployment's roster grows past it.
const MAX_ROSTER_DOCTORS = 200;

/** Compact, one-line-per-doctor roster text injected into the system prompt (see
 * pipeline.ts's buildSystemPrompt) -- gives the model real names/departments to
 * phonetically match a mis-transcribed name against before ever calling find_doctors.
 * Deliberately terse -- this is context for the model's own reasoning, never shown/spoken
 * to a caller verbatim. Returns '' for an empty roster so buildSystemPrompt can skip the
 * fragment entirely instead of injecting an empty list. */
export function formatRosterText(doctors: RosterDoctor[]): string {
  if (doctors.length === 0) return '';
  return doctors
    .slice(0, MAX_ROSTER_DOCTORS)
    .map((d) => {
      const dept = d.departmentName ? ` (${d.departmentName})` : '';
      return `${d.fullName}${dept}`;
    })
    .join('; ');
}

/** Fetches this deployment's roster ONCE, at buildServer() composition-root time (see
 * index.ts) -- never called from pipeline.ts itself, which must never touch HTTP directly
 * (see runTurn's rosterText param doc). Failure is always benign: resolves to undefined,
 * which buildSystemPrompt treats identically to "no HOSPITAL_ID configured" -- the prompt
 * just looks exactly like it did before this feature existed. Logged via the same
 * structured console.error JSON idiom audit.ts uses for a composition-root-time failure
 * with no Fastify request/logger in scope yet. */
export async function fetchRosterText(hms: HmsClient, hospitalId: string): Promise<string | undefined> {
  try {
    const { doctors } = await hms.getHospitalRoster({ hospitalId });
    const text = formatRosterText(doctors);
    return text || undefined;
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'DOCTOR_ROSTER_FETCH_FAILED',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return undefined;
  }
}
