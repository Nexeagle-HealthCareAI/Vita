import { useEffect, useState } from 'react';
import { VitaWebSDK, type PatientFormFields, type VitaState } from '@vita/web-sdk';

export function ReceptionistDashboard() {
  const [state, setState] = useState<VitaState>('IDLE');
  const [transcript, setTranscript] = useState('');
  const [formData, setFormData] = useState<PatientFormFields>({
    patient_name: '',
    phone: '',
    department: '',
  });
  const [lastError, setLastError] = useState<string | null>(null);
  const [sdk, setSdk] = useState<VitaWebSDK | null>(null);
  const [hasConsented, setHasConsented] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);

  useEffect(() => {
    const instance = new VitaWebSDK({
      gatewayOrigin: import.meta.env.VITE_GATEWAY_ORIGIN ?? 'https://gateway.vita.hospital',
      authToken: getSessionJwt(), // provided by your app's own auth flow
      userRole: 'ROLE_RECEPTIONIST',
      onTranscript: (text) => setTranscript(text),
      onFormAutofill: (fields) => setFormData((prev) => ({ ...prev, ...fields })),
      onStateChange: (s) => setState(s),
      onError: (e) => setLastError(`${e.code}: ${e.message}`),
    });
    setSdk(instance);
    return () => instance.stopSession();
  }, []);

  const isListening = state === 'LISTENING' || state === 'SPEAKING';

  return (
    <div style={{ padding: 24, fontFamily: 'Arial, sans-serif', maxWidth: 480 }}>
      <h2>1HMS Vita Registration Counter</h2>

      <p style={{ fontStyle: 'italic', color: '#666' }}>
        {transcript || 'Click "Talk to Vita" to register patients or check doctor slots...'}
      </p>

      {lastError && (
        <p role="alert" style={{ color: '#b00020', fontSize: 14 }}>
          {lastError}
        </p>
      )}

      <form style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          type="text"
          placeholder="Patient Name"
          value={formData.patient_name ?? ''}
          onChange={(e) => setFormData({ ...formData, patient_name: e.target.value })}
        />
        <input
          type="text"
          placeholder="Phone Number"
          value={formData.phone ?? ''}
          onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
        />
        <input
          type="text"
          placeholder="Department"
          value={formData.department ?? ''}
          onChange={(e) => setFormData({ ...formData, department: e.target.value })}
        />
      </form>

      <button
        onClick={() => {
          if (isListening) {
            sdk?.stopSession();
          } else if (hasConsented) {
            void sdk?.startSession(true);
          } else {
            setShowConsentModal(true);
          }
        }}
        style={{
          marginTop: 16,
          padding: '12px 24px',
          backgroundColor: isListening ? '#d32f2f' : '#0066cc',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        {isListening ? 'Stop Listening' : 'Talk to Vita'}
      </button>

      {showConsentModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-heading"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: 8,
              padding: 24,
              maxWidth: 420,
              boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
            }}
          >
            <h3 id="consent-heading" style={{ marginTop: 0 }}>
              Before we start
            </h3>
            <p style={{ fontSize: 14, lineHeight: 1.5 }}>
              Vita will listen to your voice and process it — including sending audio to our
              speech-recognition and text-to-speech providers — to answer questions, check
              doctor availability, and (for this registration counter) autofill patient
              details. A transcript and an audit record of actions taken during this call are
              kept as part of the hospital&apos;s records, in line with the Digital Personal
              Data Protection Act, 2023.
            </p>
            <p style={{ fontSize: 14, lineHeight: 1.5 }}>Do you consent to this call being recorded and processed?</p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setShowConsentModal(false)}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#fff',
                  color: '#333',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setHasConsented(true);
                  setShowConsentModal(false);
                  void sdk?.startSession(true);
                }}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#0066cc',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Accept &amp; Start
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getSessionJwt(): string {
  // Wire this up to your real auth (e.g. read from your app's session cookie
  // exchange, not localStorage — see docs/BUILD_GUIDE.md §4.3).
  return window.__TERA_DEMO_JWT__ ?? '';
}

declare global {
  interface Window {
    __TERA_DEMO_JWT__?: string;
  }
}
