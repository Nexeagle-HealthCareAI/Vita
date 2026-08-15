import { vi } from 'vitest';
import { HmsClient } from '@vita/mcp-1hms';
import { HybridRetriever, type HybridSearchResult } from '@vita/rag';
import { GroqClient, type GroqChatResult } from '../src/groq.js';
import { SarvamClient } from '../src/sarvam.js';
import type { DialogueSession } from '../src/session.js';

export function mockGroq(responses: GroqChatResult[]) {
  const groq = Object.create(GroqClient.prototype) as GroqClient;
  const chat = vi.fn();
  responses.forEach((r) => chat.mockResolvedValueOnce(r));
  groq.chat = chat;
  return groq;
}

export function mockSarvam(audio = new Uint8Array([1, 2, 3])) {
  const sarvam = Object.create(SarvamClient.prototype) as SarvamClient;
  sarvam.synthesize = vi.fn().mockResolvedValue(audio);
  // Harmless default -- routes/tests that care about a specific transcript (or a throw)
  // reassign this directly on the returned object, same pattern tools.test.ts already
  // uses for mockHms()'s individual methods.
  sarvam.transcribe = vi.fn().mockResolvedValue({ text: '' });
  return sarvam;
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
