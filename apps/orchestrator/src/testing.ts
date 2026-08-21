/**
 * Explicit, minimal public testing surface for OTHER packages in this monorepo that
 * need to exercise these real vendor-client classes against a stub -- specifically
 * tools/load-test's mockVendor contract tests, which build the real
 * SarvamSttProvider/SarvamTtsProvider/GroqBrainProvider (the exact classes this app
 * uses against the real vendors) pointed at a local stub, to catch drift in their real
 * request/response parsing that a test only exercising the stub's own routes couldn't.
 *
 * Deliberately narrow -- not a general "everything orchestrator has" export. This app
 * is deployed as a standalone service, not consumed as a library; package.json's
 * `exports` map only permits this path (plus the main entry), so a future deep import
 * into `dist/**` fails loudly at resolution time instead of silently reaching into
 * compiled internals with no contract. Add to this file only when another package
 * genuinely needs the same real class this way.
 */
export { SarvamSttProvider } from './stt/sarvam.js';
export { SarvamTtsProvider } from './tts/sarvam.js';
export { GroqBrainProvider } from './brain/groq.js';
