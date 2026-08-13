import numpy as np
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz():
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_process_frame_passthrough_and_speech_header():
    # Loud frame -> the energy-based fallback VAD should flag speech.
    loud = np.full(320, 20000, dtype=np.int16)
    res = client.post("/process", content=loud.tobytes())
    assert res.status_code == 200
    assert res.headers["X-Tera-Speech-Detected"] == "1"
    out = np.frombuffer(res.content, dtype=np.int16)
    assert np.array_equal(out, loud)  # pass-through fallback until model is wired in


def test_process_frame_silence():
    silence = np.zeros(320, dtype=np.int16)
    res = client.post("/process", content=silence.tobytes())
    assert res.headers["X-Tera-Speech-Detected"] == "0"
