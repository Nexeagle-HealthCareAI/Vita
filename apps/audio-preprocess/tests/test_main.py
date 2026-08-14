import numpy as np
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

SESSION_ID = "test-session-1"


def test_healthz():
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_process_frame_passthrough_and_speech_header():
    # Loud frame -> the energy-based fallback VAD should flag speech.
    loud = np.full(320, 20000, dtype=np.int16)
    res = client.post(f"/session/{SESSION_ID}/process", content=loud.tobytes())
    assert res.status_code == 200
    assert res.headers["X-Tera-Speech-Detected"] == "1"
    out = np.frombuffer(res.content, dtype=np.int16)
    assert np.array_equal(out, loud)  # pass-through fallback until model is wired in


def test_process_frame_silence():
    silence = np.zeros(320, dtype=np.int16)
    res = client.post(f"/session/{SESSION_ID}/process", content=silence.tobytes())
    assert res.headers["X-Tera-Speech-Detected"] == "0"


def test_session_lifecycle_delete_is_idempotent():
    session_id = "lifecycle-session"
    silence = np.zeros(320, dtype=np.int16)

    # A couple of frames create the session record.
    client.post(f"/session/{session_id}/process", content=silence.tobytes())
    client.post(f"/session/{session_id}/process", content=silence.tobytes())

    res1 = client.delete(f"/session/{session_id}")
    assert res1.status_code == 204

    # Deleting an already-gone (or never-existed) session is a silent no-op, not an
    # error -- the gateway's teardown call is fire-and-forget and must never need to
    # special-case "already gone".
    res2 = client.delete(f"/session/{session_id}")
    assert res2.status_code == 204

    res3 = client.delete("/session/never-existed")
    assert res3.status_code == 204
