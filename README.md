# Vita

Vita is a voice assistant for 1HMS reception/doctor counters — Phase 1 (web-only)
monorepo. See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the v1.1 architecture
  (topology + what changed from the original draft and why)
- [`docs/BUILD_GUIDE.md`](docs/BUILD_GUIDE.md) — step-by-step: repo → GitHub
  → E2E Networks deploy → per-module implementation detail with testing

## Layout

```
apps/
  gateway/            WS ingress: ticket auth, binary frame relay
  orchestrator/        Redis session engine, RBAC, audit log, LLM/STT/TTS/MCP/RAG orchestration
  audio-preprocess/     Python: DeepFilterNet + Silero VAD service
  web-demo/             Reference ReceptionistDashboard using @vita/web-sdk
packages/
  protocol/             Shared versioned WS event contract
  web-sdk/               @vita/web-sdk — the browser client
  mcp-1hms/              MCP server wrapping 1HMS APIs
  rag/                    Hybrid BM25 + dense retrieval over Qdrant
tools/
  load-test/             Local full-stack load/throughput harness (dev-only, never deployed)
infra/
  nginx/                 TLS + WS reverse proxy config for the E2E VM
.github/workflows/       CI (lint/typecheck/build/test) and CD (deploy to E2E)
```

## Quickstart

```bash
pnpm install
cp .env.example .env   # fill in API keys
docker compose up -d redis qdrant
pnpm dev
```

See `docs/BUILD_GUIDE.md` §2 for the full local dev loop including the
Python audio-preprocessing service, and §1 for pushing this to GitHub.

## Status

Every layer — transport, auth, session/RBAC, audit, the full STT/LLM/TTS
pipeline, real DeepFilterNet/Silero model weights, and RAG ingestion — is
implemented and tested end to end, not just scaffolded. See the status
table at the bottom of `docs/BUILD_GUIDE.md` §7 for the current
per-component breakdown and what's still open (mainly Prod deploy
provisioning and a few compliance checklist items).

## Vita migration compatibility

Vita is the canonical product and package name. Existing clients remain
compatible during migration: the gateway accepts both `vita-ticket.<ticket>`
and legacy `tera-ticket.<ticket>` WebSocket subprotocols, and orchestrator
sessions can be read through both Vita and legacy Tera Redis key prefixes.
Protocol event names, binary frame opcodes, and the bundled audio worklet
identifier remain stable because they are wire-level compatibility contracts.
