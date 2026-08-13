"""Silero VAD wrapper — authoritative turn-taking signal.

Client-side VAD in @vita/web-sdk is advisory only (drives local barge-in
UX); this service's VAD decision is what actually ends a turn and is what
emits the CLEAR_PLAYBACK barge-in event back through the orchestrator and
gateway to the client. See docs/ARCHITECTURE.md item 6.
"""

from __future__ import annotations

import numpy as np


class SileroVAD:
    def __init__(self, threshold: float = 0.5) -> None:
        self.threshold = threshold
        self._model = None  # loaded lazily so unit tests can stub this out

    def load(self) -> None:
        # Real implementation: torch.hub.load('snakers4/silero-vad', 'silero_vad')
        # Left as a TODO for the actual model load — see docs/BUILD_GUIDE.md §6.2.
        raise NotImplementedError("wire up torch.hub Silero VAD load here")

    def is_speech(self, pcm16_frame: np.ndarray) -> bool:
        if self._model is None:
            # Fallback used by unit tests / before the real model is wired in:
            # simple energy-based gate so the pipeline is exercisable end to end.
            energy = np.abs(pcm16_frame.astype(np.float32)).mean()
            return energy > 500
        raise NotImplementedError
