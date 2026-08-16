import { useEffect, useState } from 'react';
import { VitaWebSDK, type PatientFormFields, type VitaState } from '@vita/web-sdk';

export function ReceptionistDashboard() {
  const [state, setState] = useState<VitaState>('IDLE');
  const [transcript, setTranscript] = useState('');
  // Patient-detail fields aren't shown right now (kept out of the UI on request) --
  // onFormAutofill below still receives them from the SDK so re-adding the form back is
  // a small, self-contained change whenever it's wanted again.
  const [, setFormData] = useState<PatientFormFields>({
    patient_name: '',
    phone: '',
    department: '',
  });
  const [lastError, setLastError] = useState<string | null>(null);
  const [sdk, setSdk] = useState<VitaWebSDK | null>(null);
  const [hasConsented, setHasConsented] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);
  // Local-testing-only auth: real integrations provide authToken from their own session
  // cookie exchange, not a pasted value. Persisted to localStorage purely so it survives a
  // page refresh during a test session -- not a real credential store.
  const [jwt, setJwt] = useState(() => localStorage.getItem('vita_demo_jwt') ?? '');

  useEffect(() => {
    const instance = new VitaWebSDK({
      // Matches the gateway's default local port (GATEWAY_PORT in .env.example) -- `pnpm
      // dev` at the repo root (docs/BUILD_GUIDE.md §2) runs gateway + orchestrator +
      // web-demo together, so this fallback "just works" for local dev with no web-demo-
      // specific .env of its own. A real deployment must set VITE_GATEWAY_ORIGIN at build
      // time -- web-demo is reference-only and isn't part of this repo's own deploy.
      gatewayOrigin: import.meta.env.VITE_GATEWAY_ORIGIN ?? 'http://localhost:8080',
      authToken: jwt, // provided by your app's own auth flow -- pasted via the field below for local testing
      userRole: 'ROLE_RECEPTIONIST',
      onTranscript: (text) => setTranscript(text),
      onFormAutofill: (fields) => setFormData((prev) => ({ ...prev, ...fields })),
      onStateChange: (s) => setState(s),
      onError: (e) => setLastError(`${e.code}: ${e.message}`),
    });
    setSdk(instance);
    return () => instance.stopSession();
  }, [jwt]);

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

      <label htmlFor="demo-jwt" style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>
        Demo JWT (local testing only — see docs/BUILD_GUIDE.md §2 to mint one)
      </label>
      <input
        id="demo-jwt"
        type="text"
        placeholder="Paste a JWT here..."
        value={jwt}
        onChange={(e) => {
          setJwt(e.target.value);
          localStorage.setItem('vita_demo_jwt', e.target.value);
        }}
        style={{ width: '100%', padding: 8, fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box' }}
      />

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
