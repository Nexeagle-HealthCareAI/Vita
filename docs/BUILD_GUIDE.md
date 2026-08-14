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

**Load test** before go-live: `k6` or `artillery` opening N concurrent WS
sessions and streaming synthetic PCM to confirm the gateway holds up under
a full reception desk's worth of simultaneous calls.

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
it's what makes the unit tests fast and deterministic. Add a **separate**
integration test (`tests/test_models_integration.py`, marked `@pytest.mark.slow`
and excluded from the default CI job) that loads real weights against a few
recorded WAV fixtures of actual hospital reception ambience and asserts a
latency budget (e.g. p95 < 40ms per 20ms frame — must stay ahead of
realtime) and a noise-reduction quality threshold (SNR improvement vs. the
raw fixture).

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

### 3.6 `packages/mcp-1hms` — client done, tool schemas done; point at real 1HMS

`HmsClient` and the three MCP tools (`register_patient`,
`check_slot_availability`, `book_appointment`) are implemented and unit
tested against a mocked `fetch` (`packages/mcp-1hms/test/hmsClient.test.ts`).
Set `HMS_API_BASE_URL`/`HMS_API_KEY` to your real `easyHMSAPI` staging
environment and add a **contract test** (separate from the mocked unit
test) that hits staging directly and asserts the response shape still
matches `RegisterPatientInput`/etc. — run this one in a nightly CI job, not
on every PR, since it depends on an external staging service being up.

### 3.7 `packages/rag` — BM25 + fusion done; wire embeddings + Qdrant ingestion

`BM25` and the reciprocal-rank-fusion hybrid search are implemented and
tested (`packages/rag/test/bm25.test.ts`). To go live:

1. Pick an embedding model (Sarvam or a local sentence-transformer) and
   implement the `embed` callback passed into `HybridRetriever`.
2. Write an ingestion script (`packages/rag/src/ingest.ts`, not yet created)
   that chunks lab-test rules and insurance docs, embeds them, and upserts
   into Qdrant with the same `id`s used by `indexCorpus`.
3. **Testing**: a small labeled eval set (10–20 realistic receptionist
   queries with known-correct doc IDs) scored on precision@5 — this catches
   retrieval regressions that unit tests on `BM25` alone can't.

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

- [ ] Encrypt Redis session data at rest (E2E disk encryption or
      Redis-level encryption)
- [ ] Move `recordAuditEvent` (`apps/orchestrator/src/audit.ts`) from stdout
      to a durable, queryable store with a defined retention period
- [ ] Define and implement an audio retention/purge policy — how long raw
      PCM audio is kept after Sarvam STT processing, and where
- [ ] DPDPA-aligned consent notice in the web UI before a voice session
      starts
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
