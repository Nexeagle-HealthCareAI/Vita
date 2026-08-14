"""DeepFilterNet wrapper — neural noise suppression tuned for hospital/clinic ambient
noise (HVAC, PA announcements, adjacent conversations at a reception counter).

Confirmed empirically (not assumed) before writing this: unlike Silero VAD,
`enhance()` accepts this system's native 320-sample/20ms frame directly (also tested
at 480/960 samples -- all worked, shape-preserving) with no internal buffering needed.
`init_df()` is expensive cold (~1.1s, first-ever call in the process) but cheap on
repeat calls in the same process (~35ms, thanks to OS-level caching of the checkpoint
file) -- cheap enough to call once per new session rather than sharing one model
across sessions. Each session's (model, df_state) pair is therefore fully independent:
no cross-session mutable state exists at all, so -- unlike SileroVAD -- this class
needs no lock of its own; SessionRecord's per-session lock (session_registry.py) is
enough.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass
class DenoiserState:
    model: Any = None
    df_state: Any = None


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

        normalized = pcm16_frame.astype(np.float32) / 32768.0
        audio = torch.from_numpy(normalized).unsqueeze(0)
        out = enhance(state.model, state.df_state, audio)
        denoised = (out.squeeze(0).numpy() * 32768.0).clip(-32768, 32767).astype(np.int16)
        return denoised, state
