import { describe, expect, it, vi } from 'vitest';
import { FAQ_DOCS, HOSPITAL_REFERENCE_DOCS } from '@vita/rag';
import { runTurn } from '../src/pipeline.js';
import { type ChatResult } from '../src/brain/types.js';
import { mockGroq, mockTts, mockHms, mockRetriever, baseSession } from './helpers.js';

describe('runTurn — scripted conversation (golden-fixture style, per docs/BUILD_GUIDE.md §3.5)', () => {
  it('a transcript that needs a tool call: Groq requests availability, gets shifts (not slots), replies, then speaks it', async () => {
    const brain = mockGroq([
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', preferredDate: '2026-08-20' } }],
      },
      { content: 'Dr. Patel is in from 9 to 1 that day.', toolCalls: [] },
    ]);
    const tts = mockTts();
    const hms = mockHms();
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runTurn({
      session: baseSession(),
      transcript: 'Is Dr. Patel around on the 20th?',
      brain,
      tts,
      hms,
    });

    expect(result.toolCallsExecuted).toEqual(['check_doctor_availability']);
    expect(result.replyText).toBe('Dr. Patel is in from 9 to 1 that day.');
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
    expect(hms.checkDoctorAvailability).toHaveBeenCalledWith({ doctorId: 'd-1', date: '2026-08-20' });
    expect(tts.synthesize).toHaveBeenCalledWith('Dr. Patel is in from 9 to 1 that day.');

    const auditLines = auditSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(auditLines).toContainEqual(
      expect.objectContaining({ type: 'AUDIT', action: 'tool_call:check_doctor_availability', outcome: 'success' }),
    );
    auditSpy.mockRestore();

    expect(result.updatedHistory.at(-1)).toEqual({ role: 'assistant', content: 'Dr. Patel is in from 9 to 1 that day.' });
  });

  it('a multi-step conversation: find a doctor, then book -- patient details go straight into book_appointment', async () => {
    const brain = mockGroq([
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
    const tts = mockTts();
    const hms = mockHms();
    hms.findDoctors = vi.fn().mockResolvedValue({ doctors: [{ doctorId: 'd-1', fullName: 'Dr. Patel' }], totalCount: 1 });

    const result = await runTurn({
      session: baseSession(),
      transcript: 'Book Riya Sharma with a cardiologist for the 20th',
      brain,
      tts,
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
    const brain = mockGroq([{ content: 'Sure, how can I help?', toolCalls: [] }]);
    const tts = mockTts();
    const hms = mockHms();

    const result = await runTurn({ session: baseSession(), transcript: 'hello', brain, tts, hms });

    expect(result.toolCallsExecuted).toEqual([]);
    expect(result.replyText).toBe('Sure, how can I help?');
  });

  it('a doctor calling book_appointment (receptionist-only) gets an RBAC denial, audited and surfaced to the model -- not a crash', async () => {
    const brain = mockGroq([
      {
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'book_appointment', arguments: { doctorId: 'd-1', patientName: 'x', patientMobile: 'y', preferredDate: '2026-08-20' } },
        ],
      },
      { content: "I'm not able to do that as a doctor -- front desk can book it.", toolCalls: [] },
    ]);
    const tts = mockTts();
    const hms = mockHms();
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runTurn({
      session: baseSession({ role: 'ROLE_DOCTOR' }),
      transcript: 'Book a new appointment for x',
      brain,
      tts,
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

    const brain = mockGroq([{ content: 'ok', toolCalls: [] }]);
    await runTurn({ session: baseSession({ role: 'ROLE_DOCTOR' }), transcript: 'hi', brain, tts: mockTts(), hms: mockHms() });
    expect((brain.chat as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('test-doctor-model');

    const brain2 = mockGroq([{ content: 'ok', toolCalls: [] }]);
    await runTurn({ session: baseSession({ role: 'ROLE_RECEPTIONIST' }), transcript: 'hi', brain: brain2, tts: mockTts(), hms: mockHms() });
    expect((brain2.chat as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('test-admin-model');

    delete process.env.GROQ_MODEL_DOCTOR;
    delete process.env.GROQ_MODEL_ADMIN;
  });
});

describe('runTurn — round cap (a live call must never hang)', () => {
  it('stops after MAX_TOOL_ROUNDS and returns a safe fallback reply instead of looping forever', async () => {
    // Groq keeps requesting the same tool call every round, never producing a final answer.
    const alwaysToolCall: ChatResult = {
      content: null,
      toolCalls: [{ id: 'call_x', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', preferredDate: '2026-08-20' } }],
    };
    const brain = mockGroq([alwaysToolCall, alwaysToolCall, alwaysToolCall, alwaysToolCall, alwaysToolCall]);
    const tts = mockTts();
    const hms = mockHms();

    const result = await runTurn({ session: baseSession(), transcript: 'loop forever please', brain, tts, hms });

    expect(result.replyText).toMatch(/trouble completing|repeat/i);
    // Exactly 3 rounds of brain.chat -- the cap, not unbounded.
    expect((brain.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });
});

describe('runTurn — slot-tracking across turns', () => {
  it('backfills a later book_appointment call from a doctorId/preferredDate set during an earlier check_doctor_availability turn', async () => {
    const brain1 = mockGroq([
      { content: null, toolCalls: [{ id: 'call_1', name: 'check_doctor_availability', arguments: { doctorId: 'd-1', preferredDate: '2026-08-20' } }] },
      { content: 'Dr. Patel is free that day.', toolCalls: [] },
    ]);
    const tts = mockTts();
    const hms = mockHms();
    const session1 = baseSession();

    const result1 = await runTurn({ session: session1, transcript: 'Is Dr. Patel free on the 20th?', brain: brain1, tts, hms });
    expect(result1.updatedSlots).toMatchObject({ doctorId: 'd-1', preferredDate: '2026-08-20' });

    // A genuinely separate turn -- feeds turn 1's history/slots back in, the same way the
    // real /session/:id/turn route persists and reloads a session between HTTP calls. The
    // LLM's book_appointment call this time omits doctorId/preferredDate entirely, as it
    // plausibly would having already established them earlier in this same conversation.
    const session2 = { ...session1, history: result1.updatedHistory, slots: result1.updatedSlots };
    const brain2 = mockGroq([
      { content: null, toolCalls: [{ id: 'call_2', name: 'book_appointment', arguments: { patientName: 'Riya Sharma', patientMobile: '9999999999' } }] },
      { content: "Booked -- we'll confirm the exact time with you shortly.", toolCalls: [] },
    ]);

    const result2 = await runTurn({ session: session2, transcript: 'Book it for Riya Sharma, mobile 9999999999', brain: brain2, tts, hms });

    expect(hms.bookAppointment).toHaveBeenCalledWith({
      doctorId: 'd-1',
      preferredDate: '2026-08-20',
      patientName: 'Riya Sharma',
      patientMobile: '9999999999',
    });
    expect(result2.toolCallsExecuted).toEqual(['book_appointment']);
  });

  it('short-circuits book_appointment -- never calling the real HMS API -- when a required field is missing from both the call and known slots', async () => {
    const brain = mockGroq([
      {
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'book_appointment', arguments: { doctorId: 'd-1', patientName: 'Riya Sharma', preferredDate: '2026-08-20' } },
        ],
      },
      { content: 'Could I also get a mobile number for the booking?', toolCalls: [] },
    ]);
    const tts = mockTts();
    const hms = mockHms();
    const auditSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runTurn({ session: baseSession(), transcript: 'Book Riya Sharma with Dr. Patel on the 20th', brain, tts, hms });

    expect(hms.bookAppointment).not.toHaveBeenCalled();
    expect(result.toolCallsExecuted).toEqual([]); // short-circuited before dispatch, never counted as executed
    const toolResultMessage = result.updatedHistory.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    expect(JSON.parse(toolResultMessage!.content)).toMatchObject({ missingFields: ['patientMobile'] });

    const auditLines = auditSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(auditLines).toContainEqual(
      expect.objectContaining({ type: 'AUDIT', action: 'tool_call:book_appointment', outcome: 'error' }),
    );
    auditSpy.mockRestore();

    expect(result.replyText).toContain('mobile');
  });
});

describe('runTurn — search_vita_faq (generic questions about Vita itself, not 1HMS data)', () => {
  it('Groq requests the FAQ tool, gets a grounded answer, and phrases a reply from it', async () => {
    const doc = FAQ_DOCS[0]!;
    const brain = mockGroq([
      { content: null, toolCalls: [{ id: 'call_1', name: 'search_vita_faq', arguments: { query: doc.question } }] },
      { content: `${doc.answer}`, toolCalls: [] },
    ]);
    const tts = mockTts();
    const hms = mockHms();
    const faqRetriever = mockRetriever([{ id: doc.id, text: 'irrelevant raw blob', score: 0.9 }]);

    const result = await runTurn({ session: baseSession(), transcript: doc.question, brain, tts, hms, faqRetriever });

    expect(result.toolCallsExecuted).toEqual(['search_vita_faq']);
    expect(faqRetriever.search).toHaveBeenCalledWith(doc.question, 3);
    expect(result.replyText).toBe(doc.answer);
    expect(tts.synthesize).toHaveBeenCalledWith(doc.answer);
  });
});

describe('runTurn — search_hospital_reference (clinical-prep/policy questions, not Vita or 1HMS data)', () => {
  it('Groq requests the hospital-reference tool, gets a grounded answer, and phrases a reply from it', async () => {
    const doc = HOSPITAL_REFERENCE_DOCS[0]!;
    const brain = mockGroq([
      { content: null, toolCalls: [{ id: 'call_1', name: 'search_hospital_reference', arguments: { query: doc.title } }] },
      { content: `${doc.body}`, toolCalls: [] },
    ]);
    const tts = mockTts();
    const hms = mockHms();
    const hospitalReferenceRetriever = mockRetriever([{ id: doc.id, text: 'irrelevant raw blob', score: 0.9 }]);

    const result = await runTurn({ session: baseSession(), transcript: doc.title, brain, tts, hms, hospitalReferenceRetriever });

    expect(result.toolCallsExecuted).toEqual(['search_hospital_reference']);
    expect(hospitalReferenceRetriever.search).toHaveBeenCalledWith(doc.title, 3);
    expect(result.replyText).toBe(doc.body);
    expect(tts.synthesize).toHaveBeenCalledWith(doc.body);
  });
});
