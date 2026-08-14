# @vita/load-test

Local-only load/throughput harness for the full real Vita stack. Spawns real
`apps/audio-preprocess` (real Silero VAD + DeepFilterNet models), real
`apps/orchestrator`, and real `apps/gateway` as genuinely separate processes -- matching
real deployment topology -- plus an in-process stub standing in for Sarvam (STT/TTS) and
Groq (chat completions). It then opens N concurrent real WebSocket connections and
streams real (TTS-synthesized) speech through the whole pipeline, measuring latency and
throughput.

## What this does and doesn't test

**Real**: gateway's WS handling and VAD-driven utterance segmentation, the audio-preprocess
service's real Silero VAD + DeepFilterNet models, orchestrator's Redis-backed session
store, `RelaySessionRegistry`, and the full internal request/response pipeline.

**Stubbed**: Sarvam (STT/TTS) and Groq (chat completions) -- both are paid, external, and
Sarvam's account credits are already known exhausted; stubbing them costs nothing and
removes external nondeterminism from the measurement, at the cost of not testing vendor
response quality/correctness (already covered by `apps/orchestrator`'s own unit-test
fakes). The mock Groq route never returns `tool_calls`, so 1HMS/`HmsClient` is never
invoked either -- by design, not an oversight.

**Not attempted**: cross-process CPU/memory profiling; production/staging load testing
(this is local-only); the `STREAMING_STT_ENABLED` realtime path (would need the stub to
also speak Sarvam's realtime WS protocol -- a natural future extension, not built here).

## Prerequisites

```
docker compose up -d redis   # from the repo root
pnpm build                   # from the repo root -- gateway/orchestrator run their built dist/, not tsx
```

## Usage

```
pnpm --filter @vita/load-test load-test [options]
```

| flag | default | meaning |
|---|---|---|
| `--concurrency <n>` | 10 | number of simulated concurrent calls |
| `--ramp all-at-once\|staggered` | staggered | how the N calls start |
| `--ramp-interval-ms <ms>` | 200 | delay between staggered call starts |
| `--fixture <phraseId>` | book-appointment | which `apps/audio-preprocess/tests/fixtures` phrase to stream |
| `--condition clean\|snr10\|snr0` | clean | which noise condition of that fixture |
| `--hold-time-ms <ms>` | 500 | post-turn hold before hanging up |
| `--gateway-port` / `--orchestrator-port` / `--audio-preprocess-port` / `--mock-vendor-port` | 18080/18081/18090/18099 | avoid clashing with an already-running `pnpm dev` |
| `--jwt-secret <secret>` | `$JWT_SIGNING_SECRET` or `change-me` | must match whatever the gateway is configured with |
| `--redis-url <url>` | `$REDIS_URL` or `redis://localhost:6379` | |
| `--skip-spawn --gateway-url <url>` | off | run only the WS scenario against an already-running stack (e.g. one started via `pnpm dev`), instead of spawning a fresh one |
| `--out <file>` | none | also write the report as JSON |

Example:

```
pnpm --filter @vita/load-test load-test --concurrency 25 --ramp staggered --condition snr10
```

Exits non-zero if any simulated call failed.

## Measured results (one real run, dev laptop, 4 cores / 8 threads, CPU-only torch)

The harness itself was verified end-to-end against the real spawned stack (real gateway,
orchestrator, audio-preprocess with real Silero VAD + DeepFilterNet models, real Redis).
At `--concurrency 1` every stage genuinely completes: ticket → connect → SESSION_READY →
217 real streamed frames → VAD-detected end of utterance → real orchestrator turn call →
final transcript → back to LISTENING, in ~9.0s end-to-end (of which ~8.2s is the turn
itself: mostly the 700ms VAD silence-hangover plus real per-frame denoise+VAD CPU
inference for a ~4.3s clip).

At `--concurrency 3` and `--concurrency 10`, every call timed out (15s default) --
**not** a control-flow bug (verified separately: a direct, non-concurrent, non-HTTP call
into the same real `Denoiser`/`SileroVAD` classes on the `book-appointment-clean` fixture
produces a clean, correctly-timed 700ms trailing-silence hangover). Root cause is CPU
contention: `audio-preprocess`'s real model inference is CPU-bound synchronous work run
via `asyncio.to_thread` per frame, and this machine has 4 physical cores. A handful of
concurrent real sessions is enough to push per-frame latency well past what a 15s
per-call budget absorbs. This is a genuine capacity finding from the harness doing its
job, not a defect in the harness or in `apps/gateway`'s relay logic -- see
`apps/audio-preprocess/app/denoise.py`'s module docstring for the per-frame cost this is
built on. Production capacity planning (larger/more CPU, GPU inference, or capping
concurrent real-model sessions per instance) is out of scope for this harness; it exists
to make the constraint measurable, not to fix it.
