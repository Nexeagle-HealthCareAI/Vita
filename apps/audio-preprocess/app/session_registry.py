"""Per-session state registry for the real Silero VAD / DeepFilterNet models.

Mirrors the TTL-based in-memory pattern already used elsewhere in this monorepo
(apps/gateway/src/ticket.ts's single-use ticket Map, apps/orchestrator/src/session.ts's
Redis-TTL SessionStore), but adds an active background sweep rather than pure
lazy-on-read eviction: a dropped gateway connection means no future read ever arrives
for that session id, so lazy-only eviction would leak state until process restart.

Confirmed single-process/single-event-loop deployment (Dockerfile's CMD has no
--workers flag), so a plain dict is the right building block -- no cross-process
coordination needed.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field

from .denoise import Denoiser, DenoiserState
from .vad import SileroVAD, VadState

logger = logging.getLogger(__name__)


@dataclass
class SessionRecord:
    vad_state: VadState
    denoiser_state: DenoiserState
    # threading.Lock, not asyncio.Lock: inference runs via asyncio.to_thread (real OS
    # threads), so the lock guarding "restore state -> infer -> save state" as one
    # atomic unit must be safe across threads, not just across one event loop.
    lock: threading.Lock = field(default_factory=threading.Lock)
    last_seen: float = field(default_factory=time.monotonic)


class SessionRegistry:
    def __init__(self, vad: SileroVAD, denoiser: Denoiser, ttl_seconds: float = 120.0) -> None:
        self._vad = vad
        self._denoiser = denoiser
        self._ttl_seconds = ttl_seconds
        self._records: dict[str, SessionRecord] = {}
        # Guards only the check-then-insert race for a brand-new session id -- two
        # concurrent first-frames for the same new session both seeing "absent" and both
        # constructing a record. Never held during inference.
        self._create_lock = asyncio.Lock()
        self._sweep_task: asyncio.Task | None = None

    async def get_or_create(self, session_id: str) -> SessionRecord:
        record = self._records.get(session_id)
        if record is not None:
            record.last_seen = time.monotonic()
            return record

        async with self._create_lock:
            record = self._records.get(session_id)
            if record is not None:
                record.last_seen = time.monotonic()
                return record
            record = SessionRecord(
                vad_state=self._vad.new_session_state(),
                denoiser_state=self._denoiser.new_session_state(),
            )
            self._records[session_id] = record
            return record

    async def evict(self, session_id: str) -> None:
        """Explicit teardown path (gateway's DELETE /session/{id} on WS close).
        Idempotent -- evicting an unknown or already-evicted id is a silent no-op, since
        the caller's teardown call is fire-and-forget and must never need to special-case
        "already gone" (e.g. a bootstrap failure that never created a session).
        """
        self._records.pop(session_id, None)

    async def sweep_expired(self) -> None:
        """TTL safety net for connections that drop without ever reaching the explicit
        teardown call (gateway crash, network partition)."""
        now = time.monotonic()
        expired = [sid for sid, rec in self._records.items() if now - rec.last_seen > self._ttl_seconds]
        for sid in expired:
            self._records.pop(sid, None)
        if expired:
            logger.info("session_registry: TTL-swept %d idle session(s)", len(expired))

    def start_sweeper(self, interval_seconds: float = 30.0) -> None:
        async def _loop() -> None:
            while True:
                await asyncio.sleep(interval_seconds)
                try:
                    await self.sweep_expired()
                except Exception:
                    logger.exception("session_registry: sweep failed")

        self._sweep_task = asyncio.create_task(_loop())

    def stop_sweeper(self) -> None:
        if self._sweep_task is not None:
            self._sweep_task.cancel()
            self._sweep_task = None

    def session_count(self) -> int:
        return len(self._records)
