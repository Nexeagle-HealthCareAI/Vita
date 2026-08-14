from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, Request, Response

from .denoise import Denoiser
from .session_registry import SessionRecord, SessionRegistry
from .vad import SileroVAD

logger = logging.getLogger(__name__)

denoiser = Denoiser()
vad = SileroVAD()
registry = SessionRegistry(vad=vad, denoiser=denoiser)


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

    registry.start_sweeper()
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
