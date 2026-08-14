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

    Real-model test files (marked @pytest.mark.slow) want the real load() -- skip
    patching for those tests, or this fixture would silently defeat the whole point of
    those suites.
    """
    if request.node.get_closest_marker("slow"):
        return
    monkeypatch.setattr(Denoiser, "load", lambda self: None)
    monkeypatch.setattr(SileroVAD, "load", lambda self: None)


# Shared by every @pytest.mark.slow real-model test file (test_models_integration.py,
# test_real_audio_fixtures.py) -- module-scoped so the (real, ~1.1s-cold) load only
# happens once per test module, not once per test function.
@pytest.fixture(scope="module")
def loaded_vad() -> SileroVAD:
    vad = SileroVAD()
    vad.load()
    return vad


@pytest.fixture(scope="module")
def loaded_denoiser() -> Denoiser:
    denoiser = Denoiser()
    denoiser.load()
    return denoiser
