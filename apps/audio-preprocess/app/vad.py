"""Silero VAD wrapper — authoritative turn-taking signal.

Client-side VAD in @vita/web-sdk is advisory only (drives local barge-in UX); this
service's VAD decision is what actually ends a turn and is what emits the
CLEAR_PLAYBACK barge-in event back through the orchestrator and gateway to the client
(the segmentation state machine that acts on this decision lives in
apps/gateway/src/relay.ts, not here). See docs/BUILD_GUIDE.md §3.4 for the real-model
wiring this implements.

Confirmed empirically (not assumed) against the real torch.hub model before writing
this: it requires *exactly* 512 samples per call at 16kHz (not this system's native
320-sample/20ms frame -- other sizes raise ValueError), and it holds genuinely mutable
state across calls (identical input on consecutive calls without a reset produces
different output). `model.state_dict()`/`load_state_dict()` are the mechanism used
here to give each session its own isolated state off one shared loaded model -- this
specific mechanism (as opposed to `reset_states()` alone) is validated by
tests/test_models_integration.py's concurrency test against the real model, not just
asserted here.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

import numpy as np

SILERO_SAMPLE_RATE = 16000
SILERO_CHUNK_SAMPLES = 512  # hard requirement of the real model at 16kHz, not tunable


@dataclass
class VadState:
    """Opaque per-session container. `buffer` accumulates incoming 320-sample frames
    until there's enough for a real 512-sample Silero inference; `model_state` is that
    session's isolated snapshot of the shared model's state_dict; `last_decision` is
    held between inferences so every input frame still gets an is_speech answer even
    when it didn't itself trigger a fresh inference.
    """

    buffer: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    model_state: dict | None = None
    last_decision: bool = False


class SileroVAD:
    def __init__(self, threshold: float = 0.5) -> None:
        self.threshold = threshold
        self._model = None
        # Serializes ALL sessions' access to the one shared model instance -- distinct
        # from SessionRecord's per-session lock (apps/audio-preprocess/app/session_registry.py),
        # which only protects one session's own state from intra-session concurrency.
        # This lock is what makes the state_dict swap-per-session design safe: without
        # it, two sessions' load_state_dict -> forward -> state_dict sequences could
        # interleave and corrupt each other's state.
        self._model_lock = threading.Lock()

    def load(self) -> None:
        import torch

        self._model, _utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad", model="silero_vad", trust_repo=True
        )

    def new_session_state(self) -> VadState:
        return VadState()

    def is_speech(self, pcm16_frame: np.ndarray, state: VadState) -> tuple[bool, VadState]:
        if self._model is None:
            # Fallback used before the real model is wired in (or if load() failed at
            # startup -- see main.py's lifespan): simple energy-based gate, no buffering
            # needed since it's a pure per-frame function.
            energy = np.abs(pcm16_frame.astype(np.float32)).mean()
            return energy > 500, state

        import torch

        normalized = pcm16_frame.astype(np.float32) / 32768.0
        state.buffer = np.concatenate([state.buffer, normalized])

        while len(state.buffer) >= SILERO_CHUNK_SAMPLES:
            chunk = state.buffer[:SILERO_CHUNK_SAMPLES]
            state.buffer = state.buffer[SILERO_CHUNK_SAMPLES:]

            with self._model_lock:
                if state.model_state is None:
                    self._model.reset_states()
                else:
                    self._model.load_state_dict(state.model_state)
                prob = self._model(torch.from_numpy(chunk), SILERO_SAMPLE_RATE).item()
                state.model_state = {k: v.clone() for k, v in self._model.state_dict().items()}

            state.last_decision = prob > self.threshold

        return state.last_decision, state
