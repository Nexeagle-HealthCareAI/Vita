"""DeepFilterNet wrapper — neural noise suppression tuned for hospital/clinic ambient
noise (HVAC, PA announcements, adjacent conversations at a reception counter).

CORRECTNESS-CRITICAL, confirmed empirically against real speech (not assumed, and not
caught by this file's earlier synthetic-tone/noise tests -- see
tests/test_real_audio_fixtures.py, which is what actually found this): calling
`enhance()` on an ISOLATED 320-sample/20ms frame, in complete independence from
neighboring frames, produces badly degraded output -- empirically ~15x RMS
over-attenuation on genuinely clean speech, severe enough that Silero VAD downstream
stopped detecting real speech entirely. `enhance()` is a batch/offline-oriented
function: each call does its own full, independent STFT-pad-model-ISTFT round trip, so
a single isolated 20ms frame gets zero real temporal context -- unlike a proper
streaming design, repeated per-frame calls do NOT accumulate meaningful context purely
by reusing the same `df_state` (df_state only carries the STFT/ISTFT machinery, not
enough audio history for the model to make a confident speech-vs-noise judgement on 20ms
alone). Verified directly: `enhance()` called ONCE on a whole ~3s clip (full temporal
context) preserves ~70% of input RMS and VAD detects speech perfectly on the result --
same audio, same model, only the calling pattern differs.

Fix: maintain a bounded sliding-window buffer of raw recent audio per session (see
CONTEXT_SAMPLES below) and run `enhance()` on the whole window every frame, keeping only
the newly-produced tail (this frame's worth of samples) as this call's output. Window
size was swept empirically (80ms/160ms/240ms/320ms/480ms) against every fixture in
tests/fixtures/: 160ms was the smallest window that fully restored VAD-detectability on
clean and +10dB-SNR speech; CONTEXT_SAMPLES uses 200ms for headroom. This keeps
p95 latency comfortably under the 40ms/20ms-frame budget (measured ~30-40ms per frame
with a 200ms window, vs. the ~35ms *reported cost of a single isolated call* that this
file's docstring previously and misleadingly implied was sufficient on its own).

`init_df()` is expensive cold (~1.1s, first-ever call in the process) but cheap on
repeat calls in the same process (~35ms, thanks to OS-level caching of the checkpoint
file) -- cheap enough to call once per new session rather than sharing one model
across sessions. Each session's (model, df_state) pair is therefore fully independent:
no cross-session mutable state exists at all, so -- unlike SileroVAD -- this class
needs no lock of its own; SessionRecord's per-session lock (session_registry.py) is
enough.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

SAMPLE_RATE = 16000
CONTEXT_MS = 200  # see the module docstring for how this was empirically chosen
CONTEXT_SAMPLES = SAMPLE_RATE * CONTEXT_MS // 1000


@dataclass
class DenoiserState:
    model: Any = None
    df_state: Any = None
    # Raw (pre-denoise) PCM16 audio accumulated so far this session, capped at
    # CONTEXT_SAMPLES -- see the module docstring for why enhance() needs this instead
    # of being called on an isolated frame.
    history: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int16))


class Denoiser:
    def __init__(self) -> None:
        self._loaded = False

    def load(self) -> None:
        # Just proves init_df() actually works (fails loudly at Dockerfile bake time /
        # startup if it doesn't) and warms the on-disk checkpoint cache so every
        # subsequent per-session init_df() call is the fast (~35ms) path, not the slow
        # (~1.1s) cold one. The (model, df_state) constructed here isn't kept -- each
        # session gets its own via new_session_state().
        from df import init_df

        init_df()
        self._loaded = True

    def new_session_state(self) -> DenoiserState:
        if not self._loaded:
            return DenoiserState()
        from df import init_df

        model, df_state, _ = init_df()
        return DenoiserState(model=model, df_state=df_state)

    def denoise(self, pcm16_frame: np.ndarray, state: DenoiserState) -> tuple[np.ndarray, DenoiserState]:
        if state.model is None:
            # Pass-through fallback so the pipeline is exercisable before the real
            # model is wired in (or if load() failed at startup -- see main.py's
            # lifespan).
            return pcm16_frame, state

        import torch
        from df import enhance

        # Sliding-window context (see module docstring) -- append this frame, then trim
        # to the last CONTEXT_SAMPLES so per-frame cost stays bounded regardless of how
        # long the utterance has been running (not a growing/unbounded buffer).
        state.history = np.concatenate([state.history, pcm16_frame])
        if len(state.history) > CONTEXT_SAMPLES:
            state.history = state.history[-CONTEXT_SAMPLES:]

        normalized = state.history.astype(np.float32) / 32768.0
        audio = torch.from_numpy(normalized).unsqueeze(0)
        out = enhance(state.model, state.df_state, audio)
        denoised_window = (out.squeeze(0).numpy() * 32768.0).clip(-32768, 32767).astype(np.int16)
        # Only this call's frame is new output -- the rest of the window was already
        # returned (denoised slightly differently each time as more context accrues) on
        # earlier calls.
        denoised = denoised_window[-len(pcm16_frame) :]
        return denoised, state
