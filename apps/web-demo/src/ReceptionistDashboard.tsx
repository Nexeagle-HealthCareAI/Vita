import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { VitaWebSDK, type PatientFormFields, type VitaState } from '@vita/web-sdk';
import './ReceptionistDashboard.css';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export function ReceptionistDashboard() {
  const [state, setState] = useState<VitaState>('IDLE');
  const [transcript, setTranscript] = useState('');
  const [history, setHistory] = useState<Turn[]>([]);
  // Patient-detail fields aren't shown right now (kept out of the UI on request) --
  // onFormAutofill below still receives them from the SDK so re-adding the form back is
  // a small, self-contained change whenever it's wanted again.
  const [, setFormData] = useState<PatientFormFields>({
    patientName: '',
    patientMobile: '',
    specialtyCategory: '',
  });
  // Local-only, purely cosmetic -- drives the orb's glow while LISTENING (see the JSX
  // below). Zero influence on turn-taking/barge-in, which stay entirely server-driven
  // (see @vita/web-sdk's onAudioLevel doc comment).
  const [micLevel, setMicLevel] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [sdk, setSdk] = useState<VitaWebSDK | null>(null);
  const [hasConsented, setHasConsented] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);
  // Local-testing-only auth: real integrations provide authToken from their own session
  // cookie exchange, not a pasted value. Persisted to localStorage purely so it survives a
  // page refresh during a test session -- not a real credential store. `jwt` is what the
  // SDK effect below actually uses (rebuilding the SDK instance whenever it changes);
  // `jwtDraft` is the input's live value, committed to `jwt` onBlur rather than on every
  // keystroke, so typing a token doesn't tear down/rebuild the SDK dozens of times.
  const [jwt, setJwt] = useState(() => localStorage.getItem('vita_demo_jwt') ?? '');
  const [jwtDraft, setJwtDraft] = useState(jwt);
  const [showDevPanel, setShowDevPanel] = useState(() => !localStorage.getItem('vita_demo_jwt'));
  const historyRef = useRef<HTMLDivElement>(null);
  // Vita's reply can now arrive as several onReplyText calls per turn (one per sentence)
  // instead of exactly one -- this tracks whether the most recent assistant bubble is
  // still being appended to (isFinal:false so far) or was already closed off, so a
  // multi-sentence reply renders as one growing bubble instead of one bubble per sentence.
  const isReplyOpenRef = useRef(false);

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
      onTranscript: (text, isFinal) => {
        setTranscript(text);
        if (isFinal && text.trim()) {
          setHistory((prev) => [...prev, { role: 'user', text }]);
          setTranscript('');
        }
      },
      onReplyText: (text, isFinal) =>
        setHistory((prev) => {
          if (!isReplyOpenRef.current) {
            isReplyOpenRef.current = !isFinal;
            return [...prev, { role: 'assistant', text }];
          }
          isReplyOpenRef.current = !isFinal;
          const updated = [...prev];
          const last = updated[updated.length - 1]!;
          updated[updated.length - 1] = { ...last, text: last.text + text };
          return updated;
        }),
      onFormAutofill: (fields) => setFormData((prev) => ({ ...prev, ...fields })),
      onAudioLevel: setMicLevel,
      onStateChange: (s) => setState(s),
      onError: (e) => setLastError(`${e.code}: ${e.message}`),
    });
    setSdk(instance);
    return () => instance.stopSession();
  }, [jwt]);

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' });
  }, [history.length]);

  const isListening = state === 'LISTENING' || state === 'SPEAKING';
  const orbState = state.toLowerCase();

  return (
    <div className="stage">
      <header className="stage__header">
        <span className="wordmark">Vita</span>
        <span className="role-tag">Registration Counter</span>
        <button className="dev-toggle" onClick={() => setShowDevPanel((v) => !v)}>
          {showDevPanel ? 'Hide dev settings' : 'Dev settings'}
        </button>
      </header>

      {showDevPanel && (
        <div className="dev-panel">
          <label htmlFor="demo-jwt">Demo JWT (local testing only — see docs/BUILD_GUIDE.md §2 to mint one)</label>
          <input
            id="demo-jwt"
            type="text"
            placeholder="Paste a JWT here..."
            value={jwtDraft}
            onChange={(e) => {
              setJwtDraft(e.target.value);
              localStorage.setItem('vita_demo_jwt', e.target.value);
            }}
            onBlur={() => setJwt(jwtDraft)}
          />
        </div>
      )}

      <main className="stage__main">
        <div
          className={`orb-wrap orb-wrap--${orbState}`}
          // Purely cosmetic -- only reflects mic input while actually LISTENING, never
          // while SPEAKING/PROCESSING/IDLE, and never influences anything but this glow.
          style={{ '--mic-level': state === 'LISTENING' ? micLevel : 0 } as CSSProperties}
        >
          <div className="ring ring--1" />
          <div className="ring ring--2" />
          <div className="orb" />
        </div>

        <p className="caption">{transcript || (isListening ? 'Listening...' : 'Click the mic and ask about a patient or a doctor’s availability')}</p>

        {lastError && (
          <p role="alert" className="error-banner">
            {lastError}
          </p>
        )}

        <div className="history" ref={historyRef}>
          {history.length === 0 && <p className="history__empty">Your conversation with Vita will appear here.</p>}
          {history.map((turn, i) => (
            <div key={i} className={`bubble bubble--${turn.role}`}>
              {turn.text}
            </div>
          ))}
        </div>
      </main>

      <footer className="stage__footer">
        <button
          className={`mic-button mic-button--${isListening ? 'active' : 'idle'}`}
          aria-label={isListening ? 'Stop Listening' : 'Talk to Vita'}
          onClick={() => {
            if (isListening) {
              sdk?.stopSession();
            } else if (hasConsented) {
              void sdk?.startSession(true);
            } else {
              setShowConsentModal(true);
            }
          }}
        >
          {isListening ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
              <line x1="12" y1="18" x2="12" y2="22" />
            </svg>
          )}
        </button>
      </footer>

      {showConsentModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-heading">
          <div className="modal-card">
            <h3 id="consent-heading">Before we start</h3>
            <p>
              Vita will listen to your voice and process it — including sending audio to our speech-recognition and
              text-to-speech providers — to answer questions, check doctor availability, and (for this registration
              counter) autofill patient details. A transcript and an audit record of actions taken during this call
              are kept as part of the hospital&apos;s records, in line with the Digital Personal Data Protection Act,
              2023.
            </p>
            <p>Do you consent to this call being recorded and processed?</p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setShowConsentModal(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setHasConsented(true);
                  setShowConsentModal(false);
                  void sdk?.startSession(true);
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
