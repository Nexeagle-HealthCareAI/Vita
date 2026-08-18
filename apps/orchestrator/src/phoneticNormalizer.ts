/**
 * Rewrites text into a more speakable form immediately before TTS synthesis -- the
 * "phonetic normalizer" from docs/ARCHITECTURE.md's topology diagram ("Dr." -> "Doctor",
 * "10:30 AM" -> ...). Deliberately narrow, mirroring sentenceSplitter.ts's own scope
 * discipline: only the patterns below, nothing broader.
 *
 * NOT in scope: acronyms like MRI/ECG/OPD/IPD/NPO/TPA (these already read correctly as
 * spelled-out letters -- expanding them would be wrong, not right) and reformatting tool
 * call RESULTS before the LLM sees them (a different, tool-shaping concern, not a
 * TTS-boundary one -- this function only ever touches text that's about to be spoken).
 */

const HONORIFICS: Record<string, string> = { Dr: 'Doctor', Mrs: 'Missus', Mr: 'Mister', Ms: 'Miss' };
// Mrs before Mr in the alternation is cosmetic, not load-bearing -- the trailing literal
// `\.` already forces the right branch to win regardless of ordering (e.g. "Mrs." can't
// match via the "Mr" branch, since that would need the very next character to be ".",
// not "s").
const HONORIFIC_PATTERN = /\b(Dr|Mrs|Mr|Ms)\./g;

// HH:MM or HH:MM:SS, 24-hour (seconds, if present, are dropped -- never useful spoken).
// The trailing negative lookahead skips a time that already has AM/PM right after it, so
// an already-natural "2:30 PM" is left alone instead of being re-parsed as 24-hour and
// turned into "2:30 AM" -- a real double-conversion bug without this guard.
const TIME_PATTERN = /\b(2[0-3]|[01]?\d):([0-5]\d)(?::[0-5]\d)?\b(?!\s*[AaPp]\.?[Mm]\.?)/g;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
// YYYY-MM-DD (packages/mcp-1hms/src/hmsClient.ts's date format for
// CheckDoctorAvailabilityInput/BookAppointmentInput).
const DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

function to12Hour(hourStr: string, minuteStr: string): string {
  const hour24 = parseInt(hourStr, 10);
  const period = hour24 >= 12 ? 'PM' : 'AM';
  // Standard 12-hour-clock modulo: 0 and 12 both display as 12 (midnight/noon).
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minuteStr} ${period}`;
}

export function normalizePhonetics(text: string): string {
  let result = text;
  result = result.replace(HONORIFIC_PATTERN, (_match, title: string) => HONORIFICS[title] ?? _match);
  result = result.replace(TIME_PATTERN, (_match, hourStr: string, minuteStr: string) => to12Hour(hourStr, minuteStr));
  result = result.replace(DATE_PATTERN, (match, yearStr: string, monthStr: string, dayStr: string) => {
    const monthName = MONTH_NAMES[parseInt(monthStr, 10) - 1];
    if (!monthName) return match; // malformed/out-of-range month -- leave untouched rather than guess
    return `${monthName} ${parseInt(dayStr, 10)}, ${yearStr}`;
  });
  return result;
}
