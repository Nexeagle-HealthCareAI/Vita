import { describe, expect, it, vi } from 'vitest';
import { HmsClient } from '@vita/mcp-1hms';
import { runTurn } from '../src/pipeline.js';
import { GroqClient, type GroqChatResult } from '../src/groq.js';
import { SarvamClient } from '../src/sarvam.js';
import type { DialogueSession } from '../src/session.js';

function mockGroq(responses: GroqChatResult[]) {
  const groq = Object.create(GroqClient.prototype) as GroqClient;
  const chat = vi.fn();
  responses.forEach((r) => chat.mockResolvedValueOnce(r));
  groq.chat = chat;
  return groq;
}

function mockSarvam(audio = new Uint8Array([1, 2, 3])) {
  const sarvam = Object.create(SarvamClient.prototype) as SarvamClient;
  sarvam.synthesize = vi.fn().mockResolvedValue(audio);
  return sarvam;
}

function mockHms() {
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

function baseSession(overrides: Partial<DialogueSession> = {}): DialogueSession {
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

describe('runTurn — scripted conversation (golden-fixture style, per docs/BUILD_GUIDE.md §3.5)', () => {
  it('a transcript that needs a tool call: Groq requests availability, gets shifts (not slots), replies, then speaks it', async () => {
    const groq = mockGroq([
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', date: '2026-08-20' } }],
      },
      { content: 'Dr. Patel is in from 9 to 1 that day.', toolCalls: [] },
    ]);
    const sarvam = mockSarvam();
    const hms = mockHms();
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runTurn({
      session: baseSession(),
      transcript: 'Is Dr. Patel around on the 20th?',
      groq,
      sarvam,
      hms,
    });

    expect(result.toolCallsExecuted).toEqual(['check_doctor_availability']);
    expect(result.replyText).toBe('Dr. Patel is in from 9 to 1 that day.');
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
    expect(hms.checkDoctorAvailability).toHaveBeenCalledWith({ doctorId: 'd-1', date: '2026-08-20' });
    expect(sarvam.synthesize).toHaveBeenCalledWith('Dr. Patel is in from 9 to 1 that day.');

    const auditLines = auditSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(auditLines).toContainEqual(
      expect.objectContaining({ type: 'AUDIT', action: 'tool_call:check_doctor_availability', outcome: 'success' }),
    );
    auditSpy.mockRestore();

    expect(result.updatedHistory.at(-1)).toEqual({ role: 'assistant', content: 'Dr. Patel is in from 9 to 1 that day.' });
  });

  it('a multi-step conversation: find a doctor, then book -- patient details go straight into book_appointment', async () => {
    const groq = mockGroq([
      { content: null, toolCalls: [{ id: 'call_1', name: 'find_doctors', arguments: { specialtyCategory: 'Cardiology' } }] },
      {
        content: null,
        toolCalls: [
          {
            id: 'call_2',
            name: 'book_appointment',
            arguments: { doctorId: 'd-1', patientName: 'Riya Sharma', patientMobile: '9999999999', preferredDate: '2026-08-20' },
          },
        ],
      },
      { content: "Booked -- we'll confirm the exact time with you shortly.", toolCalls: [] },
    ]);
    const sarvam = mockSarvam();
    const hms = mockHms();
    hms.findDoctors = vi.fn().mockResolvedValue({ doctors: [{ doctorId: 'd-1', fullName: 'Dr. Patel' }], totalCount: 1 });

    const result = await runTurn({
      session: baseSession(),
      transcript: 'Book Riya Sharma with a cardiologist for the 20th',
      groq,
      sarvam,
      hms,
    });

    expect(result.toolCallsExecuted).toEqual(['find_doctors', 'book_appointment']);
    expect(hms.bookAppointment).toHaveBeenCalledWith({
      doctorId: 'd-1',
      patientName: 'Riya Sharma',
      patientMobile: '9999999999',
      preferredDate: '2026-08-20',
    });
    // No separate register_patient call anywhere -- there's nothing to register with.
    expect(result.replyText).toContain('Booked');
  });

  it('a transcript needing no tool at all replies directly, still gets spoken', async () => {
    const groq = mockGroq([{ content: 'Sure, how can I help?', toolCalls: [] }]);
    const sarvam = mockSarvam();
    const hms = mockHms();

    const result = await runTurn({ session: baseSession(), transcript: 'hello', groq, sarvam, hms });

    expect(result.toolCallsExecuted).toEqual([]);
    expect(result.replyText).toBe('Sure, how can I help?');
  });

  it('a doctor calling book_appointment (receptionist-only) gets an RBAC denial, audited and surfaced to the model -- not a crash', async () => {
    const groq = mockGroq([
      {
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'book_appointment', arguments: { doctorId: 'd-1', patientName: 'x', patientMobile: 'y', preferredDate: '2026-08-20' } },
        ],
      },
      { content: "I'm not able to do that as a doctor -- front desk can book it.", toolCalls: [] },
    ]);
    const sarvam = mockSarvam();
    const hms = mockHms();
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runTurn({
      session: baseSession({ role: 'ROLE_DOCTOR' }),
      transcript: 'Book a new appointment for x',
      groq,
      sarvam,
      hms,
    });

    expect(result.toolCallsExecuted).toEqual([]); // denied, not executed
    expect(hms.bookAppointment).not.toHaveBeenCalled();
    const auditLines = auditSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(auditLines).toContainEqual(
      expect.objectContaining({ type: 'AUDIT', action: 'tool_call:book_appointment', outcome: 'denied' }),
    );
    auditSpy.mockRestore();
    expect(result.replyText).toContain("not able to do that");
  });

  it('selects GROQ_MODEL_DOCTOR for a doctor session and GROQ_MODEL_ADMIN for a receptionist session', async () => {
    process.env.GROQ_MODEL_DOCTOR = 'test-doctor-model';
    process.env.GROQ_MODEL_ADMIN = 'test-admin-model';

    const groq = mockGroq([{ content: 'ok', toolCalls: [] }]);
    await runTurn({ session: baseSession({ role: 'ROLE_DOCTOR' }), transcript: 'hi', groq, sarvam: mockSarvam(), hms: mockHms() });
    expect((groq.chat as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('test-doctor-model');

    const groq2 = mockGroq([{ content: 'ok', toolCalls: [] }]);
    await runTurn({ session: baseSession({ role: 'ROLE_RECEPTIONIST' }), transcript: 'hi', groq: groq2, sarvam: mockSarvam(), hms: mockHms() });
    expect((groq2.chat as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('test-admin-model');

    delete process.env.GROQ_MODEL_DOCTOR;
    delete process.env.GROQ_MODEL_ADMIN;
  });
});

describe('runTurn — round cap (a live call must never hang)', () => {
  it('stops after MAX_TOOL_ROUNDS and returns a safe fallback reply instead of looping forever', async () => {
    // Groq keeps requesting the same tool call every round, never producing a final answer.
    const alwaysToolCall: GroqChatResult = {
      content: null,
      toolCalls: [{ id: 'call_x', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', date: '2026-08-20' } }],
    };
    const groq = mockGroq([alwaysToolCall, alwaysToolCall, alwaysToolCall, alwaysToolCall, alwaysToolCall]);
    const sarvam = mockSarvam();
    const hms = mockHms();

    const result = await runTurn({ session: baseSession(), transcript: 'loop forever please', groq, sarvam, hms });

    expect(result.replyText).toMatch(/trouble completing|repeat/i);
    // Exactly 3 rounds of groq.chat -- the cap, not unbounded.
    expect((groq.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });
});
