"""DeepFilterNet wrapper — neural noise suppression tuned for hospital/clinic
ambient noise (HVAC, PA announcements, adjacent conversations at a reception
counter). Kept behind a thin interface so it can be swapped/benchmarked
independently of the FastAPI plumbing.
"""

from __future__ import annotations

import numpy as np


class Denoiser:
    def __init__(self) -> None:
        self._model = None

    def load(self) -> None:
        # Real implementation: from df import enhance, init_df
        # self._model, self.df_state, _ = init_df()
        raise NotImplementedError("wire up DeepFilterNet model load here")

    def denoise(self, pcm16_frame: np.ndarray) -> np.ndarray:
        if self._model is None:
            # Pass-through fallback so the pipeline is exercisable before the
            # real model is wired in (and so unit tests don't need the ~100MB
            # model weights downloaded in CI).
            return pcm16_frame
        raise NotImplementedError
