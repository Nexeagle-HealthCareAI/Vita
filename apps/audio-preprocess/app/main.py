from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, Request, Response

from .denoise import Denoiser
from .session_registry import SessionRecord, SessionRegistry
from .vad import SileroVAD

logger = logging.getLogger(__name__)

# Real operational tuning knobs (unlike denoise.py's CONTEXT_MS, which stays a hardcoded
# constant deliberately -- see that file's own docstring on why it was empirically swept
# and validated, not something to casually reconfigure per deployment). A deployer might
# reasonably want a different VAD sensitivity for a noisier clinic, or a different
# session idle TTL, without touching the denoising pipeline itself.
VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))
SESSION_TTL_SECONDS = float(os.environ.get("AUDIO_PREPROCESS_SESSION_TTL_SECONDS", "120.0"))
SESSION_SWEEP_INTERVAL_SECONDS = float(os.environ.get("AUDIO_PREPROCESS_SWEEP_INTERVAL_SECONDS", "30.0"))

denoiser = Denoiser()
vad = SileroVAD(threshold=VAD_THRESHOLD)
registry = SessionRegistry(vad=vad, denoiser=denoiser, ttl_seconds=SESSION_TTL_SECONDS)

# 20ms @ 16kHz mono PCM16 -- the gateway's wire contract (RelayConfig.frameMs,
# apps/gateway/src/relay.ts) never sends anything else. Enforced here, at the HTTP
# boundary, since nothing downstream does: denoise.py's context-window tail-slice
# (`denoised_window[-len(pcm16_frame):]`) silently returns the WRONG-length output for a
# zero-length or oversized frame instead of erroring, and np.frombuffer raises an
# uncaught ValueError (-> unhandled 500, not a clean 400) on an odd-length body.
FRAME_SAMPLES = 320
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 = 2 bytes/sample


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Each model's load is independent -- one failing must not block the other, and
    # neither failing should crash the container. A failed load leaves that model's
    # internal state such that denoise()/is_speech() keep using the existing
    # pass-through/energy-threshold fallback exactly as before this change; the
    # service just runs degraded, loudly logged, rather than not running at all.
    try:
        denoiser.load()
    except Exception:
        logger.exception("denoise: failed to load DeepFilterNet -- falling back to pass-through")
    try:
        vad.load()
    except Exception:
        logger.exception("vad: failed to load Silero VAD -- falling back to energy-threshold heuristic")

    registry.start_sweeper(interval_seconds=SESSION_SWEEP_INTERVAL_SECONDS)
    yield
    registry.stop_sweeper()


app = FastAPI(title="vita-audio-preprocess", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/session/{session_id}/process")
async def process_frame(session_id: str, request: Request) -> Response:
    """Takes a raw PCM16 mono 16kHz frame, returns the denoised frame plus a
    speech/no-speech header. Internal service — called by the gateway relay
    (apps/gateway/src/relay.ts), not exposed publicly. Binary in, binary out, same
    reasoning as the client<->gateway framing: no JSON/base64 tax on a hot per-frame
    path. Session-scoped so the real streaming models (Silero VAD, DeepFilterNet) can
    keep state across the frames of one call instead of treating each one independently.
    """
    raw = await request.body()
    if len(raw) != FRAME_BYTES:
        return Response(
            status_code=400,
            content=f"expected exactly {FRAME_SAMPLES} PCM16 samples ({FRAME_BYTES} bytes), got {len(raw)} bytes".encode(),
        )
    pcm16 = np.frombuffer(raw, dtype=np.int16)

    record = await registry.get_or_create(session_id)
    denoised, speech = await asyncio.to_thread(_process_sync, record, pcm16)

    return Response(
        content=denoised.tobytes(),
        media_type="application/octet-stream",
        headers={"X-Tera-Speech-Detected": "1" if speech else "0"},
    )


def _process_sync(record: SessionRecord, pcm16: np.ndarray) -> tuple[np.ndarray, bool]:
    # torch/onnxruntime inference is synchronous, CPU-bound -- this runs via
    # asyncio.to_thread (see caller) so one session's inference never stalls other
    # concurrent sessions' /process calls on the shared event loop. The lock makes
    # "restore this session's state -> infer -> save state back" one atomic unit.
    with record.lock:
        denoised, record.denoiser_state = denoiser.denoise(pcm16, record.denoiser_state)
        speech, record.vad_state = vad.is_speech(denoised, record.vad_state)
        return denoised, speech


@app.delete("/session/{session_id}")
async def end_session(session_id: str) -> Response:
    """Explicit teardown, fired by the gateway relay when a WS connection closes
    (fire-and-forget on its side). Idempotent -- see SessionRegistry.evict.
    """
    await registry.evict(session_id)
    return Response(status_code=204)
