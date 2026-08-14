import pytest

from app.denoise import Denoiser
from app.vad import SileroVAD


@pytest.fixture(autouse=True)
def _no_real_model_loads(request, monkeypatch):
    """Whether FastAPI's TestClient triggers the `lifespan` startup handler in this
    pinned Starlette/FastAPI version is itself unverified -- getting that wrong must
    not silently start real model loads (network calls, multi-second latency) inside
    what's supposed to be the fast default CI gate (test_main.py). This makes
    correctness independent of that detail rather than assuming it either way.

    tests/test_models_integration.py is marked @pytest.mark.slow precisely because it
    wants the real load() -- skip patching for those tests, or this fixture would
    silently defeat the whole point of that suite.
    """
    if request.node.get_closest_marker("slow"):
        return
    monkeypatch.setattr(Denoiser, "load", lambda self: None)
    monkeypatch.setattr(SileroVAD, "load", lambda self: None)
