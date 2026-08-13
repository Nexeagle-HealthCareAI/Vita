from __future__ import annotations

import numpy as np
from fastapi import FastAPI, Request, Response

from .denoise import Denoiser
from .vad import SileroVAD

app = FastAPI(title="tera-audio-preprocess")
denoiser = Denoiser()
vad = SileroVAD()


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/process")
async def process_frame(request: Request) -> Response:
    """Takes a raw PCM16 mono 16kHz frame, returns the denoised frame plus a
    speech/no-speech header. Internal service — called by the orchestrator's
    audio pipeline stage, not exposed publicly. Binary in, binary out, same
    reasoning as the client<->gateway framing: no JSON/base64 tax on a hot
    per-frame path.
    """
    raw = await request.body()
    pcm16 = np.frombuffer(raw, dtype=np.int16)

    denoised = denoiser.denoise(pcm16)
    speech = vad.is_speech(denoised)

    return Response(
        content=denoised.tobytes(),
        media_type="application/octet-stream",
        headers={"X-Tera-Speech-Detected": "1" if speech else "0"},
    )
