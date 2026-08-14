"""Integration tests against REAL model weights -- NOT part of the default CI gate
(see pyproject.toml's `slow` marker registration and .github/workflows/ci.yml's
`-m "not slow"` filter). Run manually via `python -m pytest -q -m slow`.

Most fixtures here are synthetically generated (numpy tone + white noise) -- explicitly
NOT real hospital-reception audio. This validates the mechanics (does it load, does it
run fast enough, does VAD/denoise respond sanely to obviously-loud-vs-silent input,
does the session-scoped concurrency design hold against the real model) -- it is not a
real-world accuracy/quality validation (see tests/test_real_audio_fixtures.py for that).

CORRECTNESS NOTE: two tests below originally used a synthetic sine tone as a "speech"
stand-in. Confirmed empirically (while investigating a real bug test_real_audio_fixtures.py
found -- see app/denoise.py's module docstring) that the real Silero VAD NEVER classifies
a sustained sine tone as speech, at any amplitude, regardless of denoising -- it's simply
not what the model was trained to recognize, unlike an energy-threshold heuristic which
would happily call any loud sound "speech." Both tests below were passing before only
because @pytest.mark.slow tests never actually ran in CI or (apparently) locally on this
machine before this session -- the fallback energy-threshold path was silently being
exercised instead of the real model, whenever tests ran with the real load() monkeypatched
out. They're fixed here to use real speech (this file's own tests/fixtures/*.wav, shared
with test_real_audio_fixtures.py) instead of a tone.
"""

from __future__ import annotations

import asyncio
import time
import wave
from pathlib import Path

import numpy as np
import pytest

from app.denoise import Denoiser
from app.session_registry import SessionRegistry
from app.vad import SileroVAD

FRAME_SAMPLES = 320  # 20ms @ 16kHz, this system's native frame size
SAMPLE_RATE = 16000
FIXTURES_DIR = Path(__file__).parent / "fixtures"


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


def _real_speech_frames(file_name: str, start_frame: int, count: int) -> list[np.ndarray]:
    """Loads a slice of real frames from one of tests/fixtures/'s WAVs -- see that
    directory's manifest.json for exactly which portion of each file is real speech
    vs. leading/trailing silence padding."""
    with wave.open(str(FIXTURES_DIR / file_name), "rb") as wf:
        assert wf.getframerate() == SAMPLE_RATE
        raw = wf.readframes(wf.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16)
    frames = []
    for i in range(start_frame, start_frame + count):
        frame = samples[i * FRAME_SAMPLES : (i + 1) * FRAME_SAMPLES]
        if len(frame) < FRAME_SAMPLES:
            break
        frames.append(frame)
    return frames


# loaded_vad / loaded_denoiser fixtures live in conftest.py now, shared with
# test_real_audio_fixtures.py.


def test_vad_sanity_silence_vs_real_speech(loaded_vad: SileroVAD):
    state = loaded_vad.new_session_state()

    silence_decisions = []
    for _ in range(30):
        decision, state = loaded_vad.is_speech(_silence_frame(), state)
        silence_decisions.append(decision)
    assert sum(silence_decisions) <= 2, "silence should mostly not be flagged as speech"

    # book-appointment-clean.wav, frames 8-38: solidly inside its known speech region
    # (manifest.json: speechStartMs=140/frame 7 -- start one frame in for margin), no
    # denoising applied here (this test is VAD-only, matching test_vad_latency_budget's
    # scope below) so this is checking VAD's own behavior on a real (not denoised) signal.
    speech_frames = _real_speech_frames("book-appointment-clean.wav", start_frame=8, count=30)
    speech_decisions = []
    for frame in speech_frames:
        decision, state = loaded_vad.is_speech(frame, state)
        speech_decisions.append(decision)
    ratio = sum(speech_decisions) / len(speech_decisions)
    assert ratio >= 0.5, f"real speech should mostly be flagged as speech (got {ratio:.0%})"


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

    async def run_session(session_id: str, file_name: str) -> list[bool]:
        record = await registry.get_or_create(session_id)
        decisions = []
        for frame in _real_speech_frames(file_name, start_frame=8, count=40):
            decisions.append(await asyncio.to_thread(process_frame_sync, record, frame))
        return decisions

    async def main() -> tuple[list[bool], list[bool]]:
        # Two DIFFERENT real fixtures per session -- if state ever leaked between them
        # (the exact bug this test exists to catch), the two decision sequences would
        # stop reflecting their own distinct audio.
        return await asyncio.gather(
            run_session("sess-a", "doctor-availability-clean.wav"),
            run_session("sess-b", "reschedule-visit-clean.wav"),
        )

    decisions_a, decisions_b = asyncio.run(main())

    assert registry.session_count() == 2
    # Modest bar (not a strict accuracy check -- that's test_real_audio_fixtures.py's
    # job): both sessions saw real speech throughout this slice, so neither should come
    # back looking totally corrupted (e.g. all-False from a torn/cross-contaminated
    # state read). Real measured ratios for this exact slice-plus-denoise-plus-VAD
    # combination are ~0.23-0.33; 0.1 leaves comfortable margin while still failing hard
    # on genuine corruption (an all-False sequence from state cross-talk would be 0.0).
    assert sum(decisions_a) / len(decisions_a) >= 0.1, decisions_a
    assert sum(decisions_b) / len(decisions_b) >= 0.1, decisions_b
