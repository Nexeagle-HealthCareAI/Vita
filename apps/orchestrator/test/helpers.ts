import { vi } from 'vitest';
import { HmsClient } from '@vita/mcp-1hms';
import { HybridRetriever, type HybridSearchResult } from '@vita/rag';
import { GroqBrainProvider } from '../src/brain/groq.js';
import type { BrainProvider, BrainStreamChunk, ChatResult } from '../src/brain/types.js';
import { SarvamSttProvider } from '../src/stt/sarvam.js';
import type { SttProvider } from '../src/stt/types.js';
import { SarvamTtsProvider } from '../src/tts/sarvam.js';
import type { TtsProvider } from '../src/tts/types.js';
import type { DialogueSession } from '../src/session.js';

export function mockGroq(responses: ChatResult[]) {
  const brain = Object.create(GroqBrainProvider.prototype) as BrainProvider;
  const chat = vi.fn();
  responses.forEach((r) => chat.mockResolvedValueOnce(r));
  brain.chat = chat;
  // Structurally complete even though non-streaming tests never call this -- an `as
  // BrainProvider` cast on Object.create(...) doesn't get compile-time-checked for missing
  // members, so a test that accidentally exercises the streaming path via this mock would
  // otherwise type-check fine and crash at runtime instead. Tests that actually WANT
  // scripted streaming output should use mockGroqStream() below.
  brain.chatStream = vi.fn();
  return brain;
}

/** Streaming counterpart to mockGroq() -- `rounds` is one array of chunks per expected
 * brain.chatStream() call (pipeline.ts's runTurn calls it once per tool-round), each
 * yielded in order as an async generator, mirroring how a real streamed response
 * delivers content deltas followed by one done:true chunk carrying any tool calls. */
export function mockGroqStream(rounds: BrainStreamChunk[][]) {
  const brain = Object.create(GroqBrainProvider.prototype) as BrainProvider;
  brain.chat = vi.fn(); // unused by the streaming path -- present for structural completeness
  let callIndex = 0;
  brain.chatStream = vi.fn(() => {
    const chunks = rounds[callIndex] ?? [];
    callIndex++;
    return (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  });
  return brain;
}

export function mockStt(transcript = '') {
  const stt = Object.create(SarvamSttProvider.prototype) as SttProvider;
  // Harmless default -- routes/tests that care about a specific transcript (or a throw)
  // reassign this directly on the returned object, same pattern tools.test.ts already
  // uses for mockHms()'s individual methods.
  stt.transcribe = vi.fn().mockResolvedValue({ text: transcript });
  return stt;
}

export function mockTts(audio = new Uint8Array([1, 2, 3])) {
  const tts = Object.create(SarvamTtsProvider.prototype) as TtsProvider;
  tts.synthesize = vi.fn().mockResolvedValue(audio);
  return tts;
}

export function mockHms() {
  const hms = Object.create(HmsClient.prototype) as HmsClient;
  hms.findDoctors = vi.fn();
  hms.checkDoctorAvailability = vi
    .fn()
    .mockResolvedValue({ isAvailable: true, reason: null, shifts: [{ name: 'Morning', startTime: '09:00:00', endTime: '13:00:00' }] });
  hms.bookAppointment = vi
    .fn()
    .mockResolvedValue({ success: true, message: 'Your appointment request has been received.', appointmentId: 'a-1', patientId: 'p-1', isReminderSent: true });
  // Harmless default (empty roster) -- doctorRoster.test.ts and pipeline.test.ts's
  // rosterText cases override this directly, same pattern as findDoctors above.
  hms.getHospitalRoster = vi.fn().mockResolvedValue({ doctors: [] });
  hms.markAppointmentArrived = vi.fn().mockResolvedValue({ success: true, message: null, tokenNo: 1, status: 'READY' });
  return hms;
}

export function mockRetriever(results: HybridSearchResult[] = []) {
  const retriever = Object.create(HybridRetriever.prototype) as HybridRetriever;
  retriever.search = vi.fn().mockResolvedValue(results);
  return retriever;
}

export function baseSession(overrides: Partial<DialogueSession> = {}): DialogueSession {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    role: 'ROLE_RECEPTIONIST',
    turnState: 'IDLE',
    slots: {},
    history: [],
    resumeToken: 'tok-1',
    updatedAt: Date.now(),
    ...overrides,
  };
}
