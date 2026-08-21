# Vita — Architecture v1.1 (Phase 1, revised)

This supersedes the original Phase 1 diagram. Same layering, with the fixes from
the architecture review baked in as first-class components instead of left implicit.
Changes from v1.0 are marked **[NEW]** / **[CHANGED]**.

## 1. Topology

```
+--------------------------------------------------------------------------------+
|                         WEB APPLICATION CLIENT LAYER                           |
|  +----------------------------------------------------------------------------+|
|  |                        WEB SDK (@vita/web-sdk)                             ||
|  |  - Audio Capture: AudioWorkletNode (16kHz 16-bit PCM Mono)                 ||
|  |  - AEC: browser-native (getUserMedia echoCancellation) — SINGLE AEC [CHANGED]||
|  |  - Client Audio Meter: local RMS level, UI-only, no barge-in [CHANGED]     ||
|  |  - Playback: scheduled jitter-buffer queue (AudioBufferSourceNode chain)   ||
|  |  - Protocol: binary WS frames + typed events from @vita/protocol [NEW]     ||
|  |  - Session: ticket-based auth, auto-reconnect w/ backoff [NEW]             ||
|  +----------------------------------------------------------------------------+|
+--------------------------------------------------------------------------------+
              |  1. HTTPS POST /session/ticket (JWT) -> one-time ticket   [NEW]
              |  2. wss://gateway/v1/stream?ticket=... (short-lived, single-use)
              v
+--------------------------------------------------------------------------------+
|                          UNIFIED MEDIA GATEWAY                                 |
|  - Envoy/NGINX Ingress: TLS 1.3, ticket verification (not raw JWT) [CHANGED]   |
|  - Role is re-derived from JWT claims server-side, never trusted from client   |
|  - Binary frame passthrough [NEW]; single-process only -- no sticky routing yet|
|  - Frame Resampling & Transcoding                                              |
|  - relay.ts: emits CLEAR_PLAYBACK on VAD-detected barge-in [CHANGED]           |
+--------------------------------------------------------------------------------+
              v
+--------------------------------------------------------------------------------+
|                       AUDIO PRE-PROCESSING ENGINE                              |
|  - DeepFilterNet (pretrained, hospital-tuning not yet done)                    |
|  - Silero VAD -- authoritative turn-taking signal                              |
+--------------------------------------------------------------------------------+
              v
+--------------------------------------------------------------------------------+
|                        SARVAM AI SPEECH-TO-TEXT                                |
|  - Sarvam STT (en-IN / hi-IN / Hinglish)                                       |
|  - Context biasing: doctor names, dept codes, drug names, surnames             |
+--------------------------------------------------------------------------------+
              |  (final transcript)
              v
+--------------------------------------------------------------------------------+
|                  ORCHESTRATOR & DIALOGUE STATE MANAGER                         |
|  - Redis session engine (single node; session TTL + resume token) [CHANGED]    |
|  - RBAC: role derived ONLY from verified JWT claims, never client input [CHANGED]|
|  - Audit log sink: every patient-data access/tool-call is logged [NEW]         |
|  - Web Screen Sync Emitter (UI_FORM_AUTOFILL push)                             |
+--------------------------------------------------------------------------------+
        /                    |                    \
       v                     v                     v
+---------------+   +------------------+   +---------------------------+
|   GROQ API    |   |  1HMS MCP SERVER |   |      RAG SUBSYSTEM        |
| Llama3.1 8B/70B|  | register_patient |   | Qdrant hybrid BM25+Dense  |
| stream=True    |  | check_slot_avail |   | Lab rules, insurance docs |
+---------------+   | book_appointment |   +---------------------------+
        \            +------------------+           /
         \                    |                     /
          v                   v                    v
+--------------------------------------------------------------------------------+
|                        SARVAM AI TEXT-TO-SPEECH                                |
|  - Sarvam TTS, phonetic normalizer ("Dr." -> "Doctor", "10:30 AM" -> ...)      |
+--------------------------------------------------------------------------------+
              |  (chunked binary audio frames)
              v
[ Browser playback via @vita/web-sdk jitter buffer ]
```

## 2. What changed vs. v1.0, and why

| # | Change | Reason |
|---|--------|--------|
| 1 | Auth: HTTPS ticket exchange before WS upgrade, not JWT in the WS query string | Query strings land in access/proxy logs |
| 2 | Role is derived server-side from JWT claims only | Client-supplied `role` param is a privilege-escalation vector |
| 3 | `@vita/protocol` shared, versioned event contract | Prevents client/server drift, required before Phase 2 mobile SDK can truly be "zero backend changes" |
| 4 | Binary WS frames for audio instead of JSON+base64 | ~33% bandwidth/CPU overhead removed |
| 5 | Single AEC (browser-native) for Phase 1 | Two AEC engines in series fight each other; revisit custom WASM AEC only if native quality proves insufficient in real clinic noise tests |
| 6 | Client runs only a local RMS audio-level meter (not VAD); server VAD is the sole turn-taking authority | Removes ambiguity, keeps a single source of truth for turn-taking -- a client-side signal never participates in that decision at all |
| 7 | `CLEAR_PLAYBACK` event + client-side jitter-buffer flush | Barge-in must stop audio in the browser, not just server-side buffers |
| 8 | Redis session engine with session TTL + resume token -- **NOT yet Sentinel/HA-fronted** (a single plain `new IORedis(REDIS_URL)` connection today, see `apps/orchestrator/src/index.ts`; correctly described as future work in `session.ts`'s own comment and `docs/BUILD_GUIDE.md` §5) | Single-node Redis failure currently drops every active call -- this row was previously mislabeled as already shipped |
| 9 | Audit log sink in the orchestrator | Required for any real patient-data access trail (DPDPA) |
| 10 | Reconnect w/ backoff + `onError` in the SDK | Dropped WiFi at a reception desk shouldn't kill the whole interaction |

## 3. Module boundaries (maps to repo layout)

- `packages/protocol` — shared TS types + zod schemas for every WS event, versioned.
- `packages/web-sdk` — `@vita/web-sdk`, the browser client.
- `apps/gateway` — Node/Fastify WS ingress: ticket issuance/verification, binary
  frame relay -- single-process, in-memory ticket store + `RelaySessionRegistry`
  (Phase 1; no sticky routing or connection draining exist yet -- both need real
  design work once a second gateway instance is ever deployed).
- `apps/audio-preprocess` — Python (FastAPI) service: DeepFilterNet + Silero VAD, plain
  HTTP internal API (`POST .../process` per 20ms frame, `DELETE .../{sessionId}` on
  teardown) -- not gRPC/WS as earlier drafts of this doc stated; validated against a
  real p95 latency budget for the per-frame call shape (see `apps/audio-preprocess/tests`).
  Single-process, same limitation as the gateway above: `SessionRegistry` is an
  in-memory dict keyed by sessionId, with no cross-process coordination
  (`app/session_registry.py`'s own doc comment). If this is ever scaled to multiple
  replicas without sticky routing, a session's frames landing on a different replica
  mid-call silently reintroduces the isolated-frame denoising bug this service's own
  `denoise.py` docstring describes fixing at length (a fresh, empty history/model-state
  per replica, not an error) -- needs the same real design work called out above before
  a second instance is ever deployed.
- `apps/orchestrator` — Node/TS: Redis session state machine, RBAC, audit log, Groq/Sarvam/MCP/RAG orchestration.
- `packages/mcp-1hms` — MCP server wrapping 1HMS APIs (`register_patient`, `check_slot_availability`, `book_appointment`).
- `packages/rag` — ingestion + hybrid retrieval over Qdrant.
- `apps/web-demo` — reference React app (`ReceptionistDashboard`) consuming `@vita/web-sdk`.

## 4. Deployment target

E2E Networks (chosen for Indian data residency / DPDPA / ABDM / MeitY empanelment
requirements on PHI workloads — consistent with the rest of the Nexeagle stack).
Phase 1 ships as Docker Compose on a single VM behind Nginx (TLS via Let's
Encrypt), with a documented path to E2E's managed Kubernetes once traffic
justifies it. See `docs/BUILD_GUIDE.md` §7 for exact provisioning steps.
