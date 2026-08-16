# Vita — Build Guide (Phase 1)

This is the step-by-step path from an empty GitHub repo to a running Phase 1
stack on E2E Networks. It assumes `docs/ARCHITECTURE.md` (the revised v1.1
design) as ground truth. Everything referenced here (`packages/`, `apps/`,
CI workflows, Docker Compose files) already exists in this scaffold and has
been built, typechecked, and tested — this guide is what to do next with it.

---

## 0. Prerequisites

- Node.js 20+, `pnpm` 9 (`corepack enable`), Python 3.11, Docker
- A GitHub account/org to push to
- An E2E Networks account (Compute → VM) — chosen per your existing
  cloud-infra decision for DPDPA/ABDM/MeitY-compliant PHI hosting
- API keys: Sarvam AI, Groq, and your 1HMS API key (from `easyHMSAPI`)

---

## 1. Repo init & first push to GitHub

The scaffold is already a working monorepo. Turn it into a real git history
and push it:

```bash
cd tera
git init
git add -A
git commit -m "Phase 1 scaffold: protocol, web-sdk, gateway, orchestrator, audio-preprocess, mcp-1hms, rag, web-demo"
```

Create the GitHub repo (no `gh` CLI assumed — use the web UI, or if you have
`gh` authenticated locally):

```bash
gh repo create nexeagle/tera --private --source=. --remote=origin
git push -u origin main
```

If you don't use `gh`, create an empty private repo named `tera` under your
org on github.com, then:

```bash
git remote add origin git@github.com:nexeagle/tera.git
git branch -M main
git push -u origin main
```

**Branch protection**: turn on required status checks for the `CI` workflow
on `main` before anyone else pushes — `Settings → Branches → Add rule`.

**Secrets** (`Settings → Secrets and variables → Actions`), needed by
`.github/workflows/deploy.yml`. Dev and prod are separate VMs (shared with
the rest of the EasyHMS stack); auth is password-based, matching how
easyHMSAPI's own `deploy-api.yml` deploys to these same VMs:

| Secret | Value |
|---|---|
| `E2E_VM_USER` | SSH user, shared across dev and prod |
| `E2E_VM_HOST_DEV` / `E2E_VM_HOST_PROD` | public IP of the dev / prod VM |
| `E2E_VM_PASSWORD_DEV` / `E2E_VM_PASSWORD_PROD` | SSH password for that VM |
| `HMS_API_BASE_URL_DEV` / `HMS_API_BASE_URL_PROD` | easyHMSAPI base URL per environment |
| `HMS_API_KEY`, `JWT_SIGNING_SECRET`, `SARVAM_API_KEY`, `GROQ_API_KEY` | shared across both environments |

`GITHUB_TOKEN` is automatic — used to push images to `ghcr.io`. The prod VM
(`E2E_VM_HOST_PROD` / `E2E_VM_PASSWORD_PROD`) doesn't exist yet as of this
writing — `deploy-prod` is fully wired but will fail at the SSH step until
it's provisioned and those two secrets are added.

---

## 2. Local dev loop

```bash
pnpm install
cp .env.example .env   # fill in SARVAM_API_KEY, GROQ_API_KEY, HMS_API_KEY, JWT_SIGNING_SECRET
docker compose up -d redis qdrant
pnpm dev                # gateway + orchestrator + web-demo in parallel (turbo)
```

Note: `.env` must actually be at the repo root (not edited into `.env.example`, which is
git-tracked -- don't put real keys there). `gateway`'s and `orchestrator`'s `dev` scripts
load it explicitly via `tsx watch --env-file=../../.env` (`tsx`/plain `node` don't auto-load
`.env` files on their own) -- deployed environments don't need this, since
`docker-compose.prod.yml`'s `env_file: .env` directive already injects real environment
variables straight into the container, no file-loading required there.

`apps/web-demo` (`http://localhost:5173`) has no real login -- it has a "Demo JWT" field
(`ReceptionistDashboard.tsx`) that takes a pasted token instead, persisted to
`localStorage` so it survives a page refresh. Before clicking "Talk to Vita", mint one
matching your local `JWT_SIGNING_SECRET` (from the `.env` you just filled in):

```bash
cd apps/gateway
node -e "console.log(require('jsonwebtoken').sign({ sub: 'demo-user', role: 'ROLE_RECEPTIONIST' }, process.env.JWT_SIGNING_SECRET || 'change-me'))"
```

and paste the printed token into that field. Without this, `POST /session/ticket` 401s and
the UI shows a `TICKET_FETCH_FAILED` error (check the Network tab's response code to tell
this apart from `gatewayOrigin` being wrong/unreachable, which fails at the network level
instead -- `net::ERR_FAILED`, never reaching the gateway at all).

Python service, separately (different runtime):

```bash
cd apps/audio-preprocess
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8090
```

Run everything's tests:

```bash
pnpm lint && pnpm typecheck && pnpm build && CI=true pnpm test
cd apps/audio-preprocess && pytest -q
```

---

## 3. Module-by-module implementation detail

### 3.1 `packages/protocol` — done, extend as needed

The versioned event contract (`PROTOCOL_VERSION`, `ServerControlEvent`,
binary frame codec) is complete and tested (`packages/protocol/test/events.test.ts`).
When you add a new event type, add it to the `ServerControlEvent`/
`ClientControlEvent` discriminated unions here first — both the gateway and
the web SDK import from this package, so the type system catches drift
immediately. Session resume across a dropped connection now works this way:
a `SESSION_READY` event (fresh or resumed) hands the client a `sessionId`/
`resumeToken` pair, which a reconnecting client returns in `POST
/session/ticket`'s body; see `apps/gateway/src/ticket.ts`'s `ResumeIntent`
and `apps/orchestrator/src/session.ts`'s `resume()`/`rotateResumeToken()`.

### 3.2 `packages/web-sdk` — done for transport/audio plumbing; wire up your app

Ticket auth, binary framing, reconnect, jitter-buffer playback, and
barge-in are implemented and unit-tested. What's left is integration into
your actual receptionist/doctor UI beyond the reference `web-demo`:

- Replace `getSessionJwt()` in your app with your real auth flow (session
  cookie exchange, not `localStorage`).
- If you support more than Chrome/Firefox, test `AudioWorklet` availability
  and fall back gracefully (Safari < 14.1 lacks it).

**Testing**: unit tests already cover ticket-fetch failure handling,
idempotent teardown, and the jitter buffer's scheduling math
(`packages/web-sdk/test/`). Add a real end-to-end browser test once the
gateway's ticket endpoint and a mock orchestrator are both reachable — grant
Playwright a fake media stream (`--use-fake-device-for-media-stream`) and
assert on `onStateChange` transitions through a full round trip.

### 3.3 `apps/gateway` — ticket auth done; wire the orchestrator relay

`src/index.ts` has the HTTPS ticket exchange and WS upgrade fully working
and tested (`apps/gateway/test/`). The one explicit `TODO` is the relay: on
a successful ticket redemption, open an internal connection to
`ORCHESTRATOR_INTERNAL_URL` tagged with `claims.sub`/`claims.role`, and pipe:

- binary `AUDIO_INPUT_PCM16` frames from client → orchestrator
- binary `AUDIO_OUTPUT_PCM16` frames from orchestrator → client
- JSON control events both ways

Simplest Phase 1 implementation: a second `ws` client connection per
session (gateway acts as a dumb relay; all real logic lives in the
orchestrator). Add a `relay.ts` module and a test that spins up both a fake
client `ws` and a fake orchestrator `ws` and asserts frames pass through
byte-for-byte.

**Load test** before go-live: `tools/load-test` (a custom `ws`-based Node
harness, no external tool needed) spawns the real gateway, orchestrator, and
audio-preprocess as genuinely separate processes against real Redis, stubs
only the paid Sarvam/Groq vendors, and opens N concurrent WS sessions
streaming real (TTS-synthesized) PCM to confirm the gateway holds up under a
full reception desk's worth of simultaneous calls — see
`tools/load-test/README.md`.

### 3.4 `apps/audio-preprocess` — stub models, wire real weights

`app/vad.py` and `app/denoise.py` currently pass through audio unchanged
(the fallback path) so the service is independently testable
(`apps/audio-preprocess/tests/`, already passing) without needing ~100MB+ of
model weights in every CI run. To go live:

```python
# app/vad.py — SileroVAD.load()
import torch
self._model, utils = torch.hub.load('snakers4/silero-vad', 'silero_vad')

# app/denoise.py — Denoiser.load()
from df import init_df
self._model, self.df_state, _ = init_df()
```

Keep the pass-through fallback as the default when models aren't loaded —
it's what makes the unit tests fast and deterministic. A **separate**
integration test suite (`tests/test_models_integration.py` and
`tests/test_real_audio_fixtures.py`, both marked `@pytest.mark.slow` and
excluded from the default CI job, runnable on demand via the
`audio-preprocess-slow` `workflow_dispatch` job) loads real weights and
asserts a latency budget (p95 < 65ms per 20ms frame — widened from the
original 40ms figure to honestly reflect the sliding-window context buffer
`denoise.py` needs for real accuracy, see its module docstring) plus
speech-detection-ratio and noise-reduction checks. No real hospital
recordings exist or are used — the fixtures in `tests/fixtures/` are
TTS-synthesized speech (Windows SAPI, `generate_fixtures.ps1`) with
synthetic pink noise mixed in at controlled SNRs (`mix_snr.py`), an honest
stand-in for real reception audio, not a claim of being real recordings.

### 3.5 `apps/orchestrator` — session/RBAC/audit done; wire the pipeline

`SessionStore`, `assertToolPermission`, and `recordAuditEvent` are complete
and tested (`apps/orchestrator/test/`). The `/session/:id/tool-call` route
is a stub past the RBAC/audit gate — wire in:

1. STT: call Sarvam's streaming STT endpoint with the denoised audio from
   `apps/audio-preprocess`, forward `is_final` transcripts as `TRANSCRIPT`
   events back through the gateway.
2. LLM: route to Groq (`llama-3.1-8b-instant` for receptionist/admin flows,
   `llama-3.1-70b-versatile` for doctor/EMR flows — see
   `GROQ_MODEL_ADMIN`/`GROQ_MODEL_DOCTOR` in `.env.example`), `stream: true`,
   with function-calling wired to `packages/mcp-1hms` tools and
   `packages/rag` retrieval.
3. TTS: Sarvam TTS on the final response text, chunked and pushed as binary
   `AUDIO_OUTPUT_PCM16` frames.
4. On VAD-detected barge-in from `apps/audio-preprocess`, emit
   `CLEAR_PLAYBACK` immediately — don't wait for the LLM turn to finish.

**Testing**: for each stage, unit-test against a mocked HTTP client (same
pattern as `packages/mcp-1hms/test/hmsClient.test.ts` — inject `fetch`).
Then add a scripted-conversation integration test: feed a fixed sequence of
transcripts through the orchestrator with all three externals mocked, and
assert the resulting sequence of emitted events (slot fills, tool calls,
`UI_FORM_AUTOFILL` payloads) matches a golden fixture. Add a **chaos test**:
kill the Redis connection mid-session and confirm the orchestrator surfaces
a recoverable `ERROR` event rather than hanging.

### 3.6 `packages/mcp-1hms` — client, tool schemas, and contract test all done

`HmsClient` and the three MCP tools (`find_doctors`, `check_doctor_availability`,
`book_appointment` — reshaped from an earlier, more aspirational naming;
there's no standalone patient-registration endpoint and no slot-reservation
system, only shift-window availability) are implemented and unit tested
against a mocked `fetch` (`packages/mcp-1hms/test/hmsClient.test.ts`).

A separate **contract test** (`packages/mcp-1hms/test/hmsClient.contract.test.ts`)
hits a real, live `easyHMSAPI` instance — no mocking — and asserts the
response shapes `HmsClient` expects still hold, including one real write
(`bookAppointment`, using an unmistakably-labeled fake patient identity so
any accumulated rows stay greppable/deletable). It defaults to the shared
dev environment (`http://151.185.45.77:5001`) but honors
`HMS_API_BASE_URL`/`HMS_API_KEY` overrides. `.env.example`'s
`HMS_API_BASE_URL` deliberately stays a non-functional placeholder — the
contract test's own default covers this independently, and defaulting
`.env.example` itself to the shared dev URL would silently point every
local orchestrator at shared team infrastructure.

Run on demand via `pnpm --filter @vita/mcp-1hms test:contract` (uses
`vitest.contract.config.ts`; the default `vitest.config.ts` excludes this
file from `pnpm test`/CI's `node` job). Wired into CI as the
`mcp-1hms-contract` job, gated to the nightly `schedule` trigger (03:00 UTC)
plus `workflow_dispatch` only — never on a PR, since it depends on an
external service being up and performs a real write.

### 3.7 `packages/rag` — FAQ corpus live; lab-rules/insurance-doc corpus still TODO

`HybridRetriever` (BM25 + Qdrant dense + reciprocal rank fusion) is implemented and
tested (`packages/rag/test/bm25.test.ts`, `test/index.test.ts`), and is now wired
into a real, if deliberately small, first use case: a hand-written FAQ corpus about
Vita itself (`src/faqData.ts` -- what it is, what it can do, where it runs, etc.),
retrievable mid-call via the `search_vita_faq` Groq tool
(`apps/orchestrator/src/tools.ts`, wired through `pipeline.ts`'s `runTurn`).

- **Embeddings**: a local, in-process model (`src/embedder.ts`'s `LocalEmbedder`,
  `@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`, 384-dim) -- pure JS/WASM,
  no Python service, no API key, no per-call cost. Lazily loaded on first real
  `embed()` call; the load promise is cached so concurrent calls share one load.
- **Ingestion**: `pnpm --filter @vita/rag ingest` (`src/ingest.ts`) creates the
  `QDRANT_FAQ_COLLECTION` (default `vita_faq`) if missing and upserts each FAQ
  doc's embedding. Idempotent -- each doc's `id` is a fixed literal UUID (Qdrant
  only accepts unsigned ints or UUIDs as point ids, not arbitrary strings), so
  re-running always upserts in place. Must be run at least once against a real
  Qdrant (`docker compose up -d qdrant`) before `search_vita_faq` has anything to
  find -- the orchestrator's own boot only rebuilds the cheap in-memory BM25 half
  from the same `FAQ_DOCS`, it doesn't populate Qdrant.
- **Testing**: `packages/rag/test/embedder.test.ts` is a genuine exception to this
  repo's fully-offline test convention -- it does a real (small, free, local) model
  load + inference. `apps/orchestrator/test/pipeline.test.ts` covers the
  Groq-requests-the-FAQ-tool round trip with a faked retriever.

**Still not done** (unchanged from before this pass, explicitly future work, not
silently dropped): the original lab-rules/insurance-doc corpus this section used to
describe. To build that: pick a chunking strategy for real lab-test rules and
insurance docs, embed and upsert them the same way `ingest.ts` does for FAQs (a
second collection, not mixed into `vita_faq`), and add a small labeled eval set
(10-20 realistic receptionist queries with known-correct doc IDs) scored on
precision@5 -- retrieval-quality regressions on real documents are exactly what
`BM25`/`HybridRetriever`'s unit tests can't catch, since those only prove the
fusion math is correct, not that real embeddings retrieve the right real doc.

### 3.8 `apps/web-demo` — reference implementation done

`ReceptionistDashboard.tsx` is the fixed version of the original mockup,
wired to the corrected SDK. Playwright e2e tests cover the static UI
(`apps/web-demo/e2e/dashboard.spec.ts`); extend with a full voice round
trip once the gateway relay (§3.3) and orchestrator pipeline (§3.5) are
live in a test environment.

---

## 4. Deploying to E2E Networks (Phase 1: single VM)

### 4.1 Provision the VM

- E2E Networks console → Compute → create a VM (Ubuntu 22.04 LTS, sized for
  Redis + Qdrant + 3 Node services + 1 Python service — start with 4 vCPU /
  8GB RAM and scale up once you have real traffic numbers).
- Same region/data-residency choice you already made for the rest of the
  Nexeagle stack (Indian DPDPA/ABDM/MeitY constraints).

### 4.2 Base VM setup

```bash
ssh root@<vm-ip>
adduser deploy && usermod -aG docker deploy   # after installing docker below
curl -fsSL https://get.docker.com | sh
apt-get install -y docker-compose-plugin certbot
mkdir -p /home/deploy/tera-deploy && chown deploy:deploy /home/deploy/tera-deploy
```

Generate a dedicated deploy SSH keypair (don't reuse your personal key),
add the public half to `deploy`'s `~/.ssh/authorized_keys`, and put the
private half into the `E2E_VM_SSH_KEY` GitHub secret from §1.

### 4.3 TLS / domain routing

This repo doesn't run its own nginx or manage its own certs. The dev/prod VMs
are shared with the rest of the EasyHMS stack (easyHMSAPI, CMS, etc.) and
already run a reverse proxy in front of everything on :80/:443 — Vita's
`gateway` container is just exposed on a host port (`8080`, see
`docker-compose.prod.yml`) for that existing proxy to route to. Add a site
block there for Vita's domain pointing at `<vm-ip>:8080`; TLS termination and
cert renewal are handled wherever the rest of that proxy config already lives,
not in this repo.

### 4.4 First deploy

```bash
# on the VM, as `deploy`
cd ~/tera-deploy
# .env is NOT committed — copy it here manually or via a secrets manager
scp your-local/.env deploy@<vm-ip>:~/tera-deploy/.env
docker compose -f docker-compose.prod.yml up -d
```

After this, every push to `main` runs `.github/workflows/deploy.yml`:
build+push images to `ghcr.io`, then SSH into the VM, pull, and
`docker compose up -d` — see that file for the exact steps.

### 4.5 Smoke test

```bash
curl https://gateway.vita.hospital/healthz
# {"status":"ok"}
```

Then open `apps/web-demo` (deployed separately or run locally pointed at
the prod `gatewayOrigin`) and confirm ticket exchange + WS upgrade succeed
in the browser network tab.

---

## 5. Path to Kubernetes (post-Phase-1)

Once traffic justifies it, move off single-VM Compose to E2E's managed
Kubernetes: containerize is already done (same Dockerfiles), add a Redis
Sentinel/managed-Redis for HA (closes the gap in
`docs/ARCHITECTURE.md` item 8), and use `k8s` Ingress + cert-manager in
place of the shared-VM reverse proxy in §4.3. Not required for Phase 1 launch.

---

## 6. Compliance checklist (do this before real patient data flows)

- [x] Encrypt Redis session data at rest (E2E disk encryption or
      Redis-level encryption) — neither option is actually available from
      this repo (disk encryption is a VM/hosting-console setting; Redis OSS,
      what's actually deployed, has no at-rest encryption feature at all).
      Went with a third option instead: application-level AES-256-GCM
      encryption of the session JSON blob before it reaches Redis
      (`apps/orchestrator/src/sessionCrypto.ts`, wired into `SessionStore`'s
      `persist()`/`get()` in `session.ts`). Gated on `SESSION_ENCRYPTION_KEY`
      — unset stores plain JSON exactly as before (every existing test and
      environment today), so this ships dark until the key is actually set.
      No data-migration logic: `SessionStore`'s 30-minute TTL means any
      session from before a key toggle just expires and self-heals within
      that window
- [x] Move `recordAuditEvent` (`apps/orchestrator/src/audit.ts`) from stdout
      to a durable, queryable store with a defined retention period — a new
      Postgres service (`apps/orchestrator/src/auditStore.ts`'s
      `PostgresAuditStore`); every existing call site is unchanged, `ts`/
      `session_id`/etc. are indexed and queryable via SQL, and
      `initAuditStore()`'s daily purge enforces a 365-day retention
      (`AUDIT_RETENTION_DAYS`). Requires the `POSTGRES_PASSWORD` GitHub
      secret to actually persist in deployed environments (see
      `.github/workflows/deploy.yml`) — degrades safely to the old
      stdout-only behavior until it's added
- [x] Define and implement an audio retention/purge policy — how long raw
      PCM audio is kept after Sarvam STT processing, and where. Traced the
      full pipeline end to end: raw PCM only ever lives in small in-memory
      buffers, per frame/utterance — `ConnectionRelay.buffer`/`preRoll`
      (`apps/gateway/src/relay.ts`), audio-preprocess's bounded denoise/VAD
      context windows, and the orchestrator's `/turn/audio` handler and
      `SarvamClient`/`SarvamRealtimeSession` — all explicitly cleared per
      utterance or falling out of scope once a turn completes. `SessionStore`
      (`apps/orchestrator/src/session.ts`) only ever persists transcript
      text, never audio bytes. **No code path in this repo writes raw audio
      to disk, Redis, or any log** — so there's no retention/purge policy to
      implement here; the policy is "not persisted at all." The one
      genuinely open question — how long Sarvam itself retains audio after
      receiving it for STT — is a vendor-contract/policy question, not
      something this repo's code controls
- [x] DPDPA-aligned consent notice in the web UI before a voice session
      starts — `ReceptionistDashboard.tsx`'s consent modal gates
      `sdk.startSession(consentGiven)`; the flag rides the existing ticket
      exchange (`@vita/web-sdk` → gateway `POST /session/ticket` → WS →
      `ConnectionRelay`) to the orchestrator's `POST /session`, the one place
      it's actually enforced (400 + a `consent_missing`/denied audit line if
      absent) and audited (`consent_given`/success otherwise) via the
      existing `recordAuditEvent`
- [ ] Review 1HMS API access scoping — `HMS_API_KEY` in this service should
      have the minimum permissions `register_patient`/`check_slot_availability`/
      `book_appointment` actually need, not full API access

---

## 7. Summary of what's already built vs. what's next

| Component | Status |
|---|---|
| `@vita/protocol` | done, tested |
| `@vita/web-sdk` | done, tested (transport/audio/playback layer) |
| `apps/gateway` | ticket auth done, tested; orchestrator relay is a TODO |
| `apps/orchestrator` | session/RBAC/audit done, tested; STT/LLM/TTS pipeline is a TODO |
| `apps/audio-preprocess` | service scaffold done, tested; real model weights are a TODO |
| `@vita/mcp-1hms` | done, tested against mocked 1HMS API |
| `@vita/rag` | BM25 + fusion done, tested; embeddings + ingestion are a TODO |
| `apps/web-demo` | done, tested (UI layer) |
| CI (`ci.yml`) | done — lint/typecheck/build/test on every PR |
| CD (`deploy.yml`) | done — builds images, deploys to E2E VM on `main` |
| Compliance | not started — see §6 before go-live |
