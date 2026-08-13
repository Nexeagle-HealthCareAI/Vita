# @tera/web-sdk

Browser client SDK for Tera. Fixes applied vs. the original Phase 1 draft:

- **Auth**: JWT is exchanged for a short-lived, single-use ticket over HTTPS
  (`POST /session/ticket`) before the WebSocket ever opens — the long-lived
  token never appears in a WS URL or proxy log.
- **Framing**: audio is sent/received as binary WebSocket frames (1-byte type
  prefix + raw PCM16), not JSON+base64.
- **Playback**: `JitterBufferPlayer` schedules chunks against
  `audioContext.currentTime` for gapless playback under real network jitter,
  and exposes `flush()` for barge-in.
- **Barge-in**: handles the `CLEAR_PLAYBACK` server event end-to-end.
- **Resilience**: exponential-backoff auto-reconnect, explicit `onError`
  callback, idempotent `stopSession()`.
- **AEC**: relies on the browser's native `echoCancellation` only — no
  second WASM AEC stage fighting the same echo path.

## Usage

```ts
import { TeraWebSDK } from '@tera/web-sdk';

const sdk = new TeraWebSDK({
  gatewayOrigin: 'https://gateway.tera.hospital',
  authToken: userJwt,
  userRole: 'ROLE_RECEPTIONIST',
  onTranscript: (text, isFinal) => setTranscript(text),
  onFormAutofill: (fields) => setFormData((prev) => ({ ...prev, ...fields })),
  onStateChange: (state) => setListening(state === 'LISTENING'),
  onError: (e) => console.warn(`[tera] ${e.code}: ${e.message}`),
});

await sdk.startSession();
// ...
sdk.stopSession();
```

## Testing

`pnpm --filter @tera/web-sdk test` — unit tests mock `AudioContext`,
`WebSocket`, and `fetch`; see `test/`. Browser-level integration testing
(real `AudioWorklet`, real mic) is covered separately in
`apps/web-demo` via Playwright — see `docs/BUILD_GUIDE.md` §4.2.
