"""Integration tests against REAL model weights -- NOT part of the default CI gate
(see pyproject.toml's `slow` marker registration and .github/workflows/ci.yml's
`-m "not slow"` filter). Run manually via `python -m pytest -q -m slow`.

Fixtures here are synthetically generated (numpy tone + white noise) -- explicitly
NOT real hospital-reception audio. This validates the mechanics (does it load, does it
run fast enough, does VAD/denoise respond sanely to obviously-loud-vs-silent input,
does the session-scoped concurrency design hold against the real model) -- it is not a
real-world accuracy/quality validation.
"""

from __future__ import annotations

import asyncio
import time

import numpy as np
import pytest

from app.denoise import Denoiser
from app.session_registry import SessionRegistry
from app.vad import SileroVAD

FRAME_SAMPLES = 320  # 20ms @ 16kHz, this system's native frame size
SAMPLE_RATE = 16000

pytestmark = pytest.mark.slow


def _silence_frame() -> np.ndarray:
    return np.zeros(FRAME_SAMPLES, dtype=np.int16)


def _tone_with_noise_frame(rng: np.random.Generator, t_offset: float) -> np.ndarray:
    t = t_offset + np.arange(FRAME_SAMPLES) / SAMPLE_RATE
    tone = 0.3 * np.sin(2 * np.pi * 220 * t)
    noise = rng.normal(0, 0.05, FRAME_SAMPLES)
    return np.clip((tone + noise) * 32767, -32768, 32767).astype(np.int16)


def _noise_only_frame(rng: np.random.Generator) -> np.ndarray:
    noise = rng.normal(0, 0.2, FRAME_SAMPLES)
    return np.clip(noise * 32767, -32768, 32767).astype(np.int16)


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


def test_vad_sanity_silence_vs_tone(loaded_vad: SileroVAD):
    rng = np.random.default_rng(42)
    state = loaded_vad.new_session_state()

    silence_decisions = []
    for _ in range(30):
        decision, state = loaded_vad.is_speech(_silence_frame(), state)
        silence_decisions.append(decision)
    assert sum(silence_decisions) <= 2, "silence should mostly not be flagged as speech"

    tone_decisions = []
    for i in range(30):
        frame = _tone_with_noise_frame(rng, i * FRAME_SAMPLES / SAMPLE_RATE)
        decision, state = loaded_vad.is_speech(frame, state)
        tone_decisions.append(decision)
    assert sum(tone_decisions) >= 20, "a sustained tone should mostly be flagged as speech"


def test_vad_latency_budget(loaded_vad: SileroVAD):
    rng = np.random.default_rng(7)
    state = loaded_vad.new_session_state()
    frames = [_tone_with_noise_frame(rng, i * FRAME_SAMPLES / SAMPLE_RATE) for i in range(300)]

    latencies_ms = []
    for frame in frames:
        t0 = time.perf_counter()
        _, state = loaded_vad.is_speech(frame, state)
        latencies_ms.append((time.perf_counter() - t0) * 1000)

    p95 = float(np.percentile(latencies_ms, 95))
    # BUILD_GUIDE's suggested budget; the Step 0 spike measured ~0.4ms/inference for
    # Silero alone (well under this), so this mostly guards the buffering overhead.
    assert p95 < 40, f"VAD p95 latency {p95:.2f}ms exceeds the 40ms/20ms-frame budget"


def test_denoise_reduces_pure_noise_energy(loaded_denoiser: Denoiser):
    rng = np.random.default_rng(99)
    state = loaded_denoiser.new_session_state()

    input_energy = 0.0
    output_energy = 0.0
    for _ in range(50):
        frame = _noise_only_frame(rng)
        input_energy += float(np.abs(frame.astype(np.float32)).mean())
        denoised, state = loaded_denoiser.denoise(frame, state)
        output_energy += float(np.abs(denoised.astype(np.float32)).mean())

    assert output_energy < input_energy, "denoising pure noise should reduce average energy"


def test_denoise_latency_budget(loaded_denoiser: Denoiser):
    rng = np.random.default_rng(13)
    state = loaded_denoiser.new_session_state()
    frames = [_tone_with_noise_frame(rng, i * FRAME_SAMPLES / SAMPLE_RATE) for i in range(300)]

    latencies_ms = []
    for frame in frames:
        t0 = time.perf_counter()
        _, state = loaded_denoiser.denoise(frame, state)
        latencies_ms.append((time.perf_counter() - t0) * 1000)

    p95 = float(np.percentile(latencies_ms, 95))
    assert p95 < 40, f"denoise p95 latency {p95:.2f}ms exceeds the 40ms/20ms-frame budget"


def test_concurrent_sessions_never_cross_talk(loaded_vad: SileroVAD, loaded_denoiser: Denoiser):
    """The one test that actually proves the session-scoped concurrency design (a
    shared, locked Silero model + independent per-session DeepFilterNet instances)
    holds against the real loaded models, not just the theoretical lock design.

    Routes each frame through asyncio.to_thread, same as main.py's real request
    handler -- without a real thread-hop per frame, asyncio.gather wouldn't actually
    interleave the two sessions (no await point inside a plain synchronous loop), and
    this test would silently stop testing anything about concurrency at all.
    """
    registry = SessionRegistry(vad=loaded_vad, denoiser=loaded_denoiser, ttl_seconds=60)

    def process_frame_sync(record, frame: np.ndarray) -> bool:
        with record.lock:
            denoised, record.denoiser_state = loaded_denoiser.denoise(frame, record.denoiser_state)
            decision, record.vad_state = loaded_vad.is_speech(denoised, record.vad_state)
            return decision

    async def run_session(session_id: str, seed: int) -> list[bool]:
        rng = np.random.default_rng(seed)
        record = await registry.get_or_create(session_id)
        decisions = []
        for i in range(40):
            frame = _tone_with_noise_frame(rng, i * FRAME_SAMPLES / SAMPLE_RATE)
            decisions.append(await asyncio.to_thread(process_frame_sync, record, frame))
        return decisions

    async def main() -> tuple[list[bool], list[bool]]:
        return await asyncio.gather(run_session("sess-a", 1), run_session("sess-b", 2))

    decisions_a, decisions_b = asyncio.run(main())

    assert registry.session_count() == 2
    # Both sessions saw sustained tone throughout -- neither should come back looking
    # like it was corrupted by the other (e.g. all-False from a torn state read).
    assert sum(decisions_a) >= 20
    assert sum(decisions_b) >= 20
