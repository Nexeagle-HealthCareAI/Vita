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
assert the resulting sequence of emitted events (tool calls, slot fills,
`UI_FORM_AUTOFILL` payloads) matches a golden fixture — see
`apps/orchestrator/test/pipeline.test.ts`'s "slot-tracking across turns"
describe block and `test/streamSession.integration.test.ts`'s
`turn.form_autofill` tests for exactly this, now real (§3.5.1 below). Add a
**chaos test**: kill the Redis connection mid-session and confirm the
orchestrator surfaces a recoverable `ERROR` event rather than hanging.

#### 3.5.1 Slot-tracking / turn-state synchronization — done

`DialogueSession.slots: Record<string, unknown>` (`session.ts`) was a
placeholder field, round-tripping through Redis (encryption-at-rest
included) but never read or written by any code, until this pass.
`apps/orchestrator/src/slots.ts` now backs it with real behavior, all driven
by `pipeline.ts`'s `runToolCalls()`:

- **Backfill**: before dispatching a tool call, any of its own known
  parameters left empty by the LLM are filled from `slots` if something
  earlier in the SAME session already established a value (e.g. a `doctorId`
  found via `find_doctors` two turns ago). A deterministic safety net
  against a small model (`llama-3.1-8b-instant`) mistyping or hallucinating
  a value it should just be copying forward — never a way to let the LLM
  skip supplying arguments in the first place (`SYSTEM_PROMPT` explicitly
  tells it not to invent tool-call arguments either). `check_doctor_availability`'s
  `date` parameter was renamed to `preferredDate` specifically so it shares
  a name with `book_appointment`'s own field — without that, "is Dr. X free
  on the 20th?" → "book that" would get zero benefit from this at all.
- **Pre-dispatch validation**: after backfill, a tool call still missing a
  required parameter never reaches `executeTool`/the real 1HMS API — it's
  short-circuited with a structured `{ error, missingFields }` tool result
  instead, closing a real, previously-silent backend bug (easyHMSAPI only
  validates `doctorId`/`patientMobile` server-side; a missing `preferredDate`
  used to silently proceed with a zero-value date).
- **Merge + booking-scoped clear**: a call's (backfilled) arguments are
  merged into `slots` after dispatch, last-write-wins, never erasing an
  existing value with an empty one. `slots.ts`'s `clearBookingSlots()` wipes
  the booking-identity keys (`doctorId`/`patientName`/`patientMobile`/
  `preferredDate`/`preferredTime`/`reason`) after every *successful*
  `book_appointment`, so a second patient booked later in the same call
  never silently inherits the first patient's stale contact info via
  backfill. **Known, accepted residual risk**: a doctor-pivot mid-flow
  (check availability for Dr. A, decide on Dr. C instead, then a
  `book_appointment` call that omits `doctorId`) can still backfill the
  wrong doctor until a booking actually completes — solving that would need
  real intent-tracking, out of scope for what's fundamentally an
  LLM-reliability safety net, not a hard guarantee system.

**`UI_FORM_AUTOFILL` emission** (the "Web Screen Sync Emitter" box in
`docs/ARCHITECTURE.md`'s topology diagram) is now wired end-to-end — the
wire format (`packages/protocol/src/events.ts`'s `FormAutofillEvent`) and
client listener (`packages/web-sdk`) already existed, nothing sent it until
this pass:

- `pipeline.ts`'s `runTurn()` tracks a second, `touchedSlots` accumulator
  alongside `slots` — it mirrors every merge but is never reset by
  `clearBookingSlots`, specifically so a just-booked patient's details still
  reach the UI once even if a receptionist states an entire booking in one
  breath (set-then-cleared within the SAME turn). `RunTurnResult.formFieldsThisTurn`
  is `diffSlots(session.slots, touchedSlots)` — what's new-or-changed this
  turn, computed once, not the same thing as `session.slots` vs.
  `updatedSlots` (which would show nothing changed in that same scenario).
- **Role-gated orchestrator-side**, in `index.ts`'s `computeFormFields()`
  and `streamSession.ts`'s `handleFinalTranscript()` — the authoritative
  check (every other authorization decision in this codebase,
  `assertToolPermission`, already lives orchestrator-side too). A
  `ROLE_DOCTOR` session never computes, sends, or audits a push at all.
  `apps/gateway/src/relay.ts`'s `onFormAutofill()` re-checks `claims.role`
  too, but only as cheap, redundant defense-in-depth, not the primary gate.
- Sent at most once per turn: as a `formFields` field (`null` when nothing
  changed) on the `/session/:id/turn` and `/session/:id/turn/audio` JSON
  responses, and as a `turn.form_autofill` WS message (only sent at all when
  there's something to send) on the real-time stream path — which the
  gateway (`orchestratorStreamClient.ts` → `streamingTurnBackend.ts` →
  `relay.ts`) relays onward as a real `UI_FORM_AUTOFILL` event to the
  browser client. Every successful push is also audited as
  `form_autofill_push` (`audit.ts`'s own doc comment already named this
  action, aspirationally, before this pass).
- **Known, accepted limitation**: a session resume/reconnect doesn't
  re-send previously-pushed slot values — `SESSION_READY` carries no slot
  data, so a client that reconnects mid-call only sees slot changes from
  that point forward. Not built, since `apps/web-demo`'s reference form
  isn't rendered yet either (`ReceptionistDashboard.tsx` receives
  `onFormAutofill` but discards it) — write this down rather than
  rediscover it whenever the real form gets built.

#### 3.5.2 Upfront RBAC — done

RBAC was previously enforced only at tool-dispatch time
(`assertToolPermission`, throwing `ForbiddenError`, checked inside
`executeTool` and, since §3.5.1's slot-tracking work, again explicitly in
`pipeline.ts`'s `runToolCalls` before backfill/validation runs) — the full
`TOOL_SCHEMAS` array was sent to Groq on every turn regardless of role, so
a `ROLE_DOCTOR` session was offered `book_appointment` exactly like a
receptionist and only got denied if it actually tried to call it.

This is now additionally enforced upfront, on top of (not instead of) the
existing dispatch-time check, which remains the real deny-by-default
enforcement boundary:

- `rbac.ts`'s `isToolAllowed(tool, role)` — a non-throwing counterpart to
  `assertToolPermission`, sharing the same `TOOL_PERMISSIONS` map and the
  same deny-by-default behavior for an unknown tool.
- `tools.ts`'s `toolSchemasForRole(role)` filters `TOOL_SCHEMAS` down to
  what that role may actually call, before it's ever sent to
  `brain.chat()`/`brain.chatStream()` — computed once per turn in
  `pipeline.ts`'s `runTurn()` (`session.role` never changes for a
  session's lifetime, so this never needs recomputing mid-turn).
- `pipeline.ts`'s `SYSTEM_PROMPT` (now `buildSystemPrompt(role)`) is
  similarly role-scoped — a doctor's prompt never mentions
  `book_appointment` at all, keeping the prompt consistent with the tool
  list actually offered alongside it.

Today's practical effect is narrow (every tool except `book_appointment`
is already allowed for both roles) but the mechanism scales automatically:
a future doctor-only tool with a real schema and `executeTool` case is
filtered/described correctly with no changes needed here.

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

### 3.7 `packages/rag` — two live corpora (FAQ + hospital reference); real hospital content still TODO

`HybridRetriever` (BM25 + Qdrant dense + reciprocal rank fusion) is implemented and
tested (`packages/rag/test/bm25.test.ts`, `test/index.test.ts`), and is wired into
two separate corpora, each with its own Qdrant collection and Groq tool:

- A hand-written FAQ corpus about Vita itself (`src/faqData.ts` -- what it is, what
  it can do, where it runs, etc.), retrievable mid-call via the `search_vita_faq`
  tool.
- A ~14-doc hospital-reference corpus (`src/hospitalReferenceData.ts` -- clinical-prep
  questions like fasting/MRI/colonoscopy prep, and hospital-policy questions like
  visiting hours, admission documents, discharge process, insurance/billing basics),
  retrievable via the `search_hospital_reference` tool. **Sample content**: no real,
  hospital-verified policy or clinical-prep content exists anywhere in the EasyHMS
  ecosystem today (no admin UI, no document store) -- these docs are hand-written,
  clearly-labeled illustrative placeholders (see the file's SAMPLE-CONTENT NOTE),
  written in deliberately hedged/general-guidance phrasing rather than absolute
  clinical directives. Swapping in real hospital-specific content later needs no
  pipeline changes. Because a caller could otherwise hear placeholder clinical-prep
  text via TTS with no audible indication it's illustrative,
  `apps/orchestrator/src/pipeline.ts`'s `SYSTEM_PROMPT` instructs the model to
  always follow anything from this tool with a spoken reminder to confirm exact
  details with hospital staff -- a second, prompt-level layer of the same
  mitigation.

Both tools are wired through `apps/orchestrator/src/tools.ts` and `pipeline.ts`'s
`runTurn`, RBAC-allowed for both `ROLE_RECEPTIONIST` and `ROLE_DOCTOR`
(`apps/orchestrator/src/rbac.ts`).

- **Embeddings**: a local, in-process model (`src/embedder.ts`'s `LocalEmbedder`,
  `@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`, 384-dim) -- pure JS/WASM,
  no Python service, no API key, no per-call cost. Lazily loaded on first real
  `embed()` call; the load promise is cached so concurrent calls share one load.
  `apps/orchestrator/src/index.ts`'s `buildServer()` constructs exactly ONE
  `LocalEmbedder` and shares it across both retrievers -- since the load is cached
  per instance, not sharing it would mean loading the same WASM model twice.
- **Ingestion**: `pnpm --filter @vita/rag ingest` (`src/ingest.ts`) upserts both
  corpora via a shared `ensureCollectionAndUpsert()` helper -- `FAQ_DOCS` into
  `QDRANT_FAQ_COLLECTION` (default `vita_faq`), `HOSPITAL_REFERENCE_DOCS` into
  `QDRANT_HOSPITAL_REFERENCE_COLLECTION` (default `vita_hospital_reference`).
  Idempotent -- each doc's `id` is a fixed literal UUID (Qdrant only accepts
  unsigned ints or UUIDs as point ids, not arbitrary strings), so re-running always
  upserts in place. Must be run at least once against a real Qdrant (`docker
  compose up -d qdrant`) before either tool has anything to find -- the
  orchestrator's own boot only rebuilds the cheap in-memory BM25 half from the same
  doc arrays, it doesn't populate Qdrant.
- **Eval**: `pnpm --filter @vita/rag eval` (`src/evalHospitalReference.ts`) runs ~12
  labeled `{query, expectedSlug}` pairs against the real retriever and reports
  precision@5. Manual-only, like `ingest.ts` -- needs a real, already-ingested
  Qdrant plus a real embedding-model load. **Deliberately not wired into
  vitest/CI**: unlike `mcp-1hms-contract`'s nightly-CI pattern (which just calls an
  already-running external service), automating this would need new CI
  infrastructure (a Qdrant service container plus an ingest step) that doesn't
  exist yet -- a named deferral, not an implicit omission.
- **Testing**: `packages/rag/test/embedder.test.ts` is a genuine exception to this
  repo's fully-offline test convention -- it does a real (small, free, local) model
  load + inference. `packages/rag/test/hospitalReferenceData.test.ts` sanity-checks
  the corpus itself (unique/valid UUIDs, unique slugs, non-empty fields).
  `apps/orchestrator/test/pipeline.test.ts` covers both the
  Groq-requests-the-FAQ-tool and Groq-requests-the-hospital-reference-tool round
  trips with faked retrievers; `apps/orchestrator/test/tools.test.ts` covers
  dispatch/RBAC/no-retriever-supplied for both tools.

**Still not done** (explicitly future work, not silently dropped): real,
hospital-verified content to replace the sample hospital-reference docs, and
per-hospital scoping (there's no tenant/`hospitalId` concept anywhere in the
retrieval path or in `DialogueSession` upstream of it today -- retrieval stays
global for both corpora until that's threaded through the whole chain).

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
