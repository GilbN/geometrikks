"""Rolling classification window for a tailed file's peer addresses.

Pure bookkeeping: no I/O, no logging, no parser knowledge. The parser
records kinds and logs the transitions check() returns; /health reads
summary(). record() is O(1); shares are only computed in check() (every
PEER_CHECK_EVERY records) and summary().
"""
from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass
from typing import Literal

PeerKind = Literal["cdn", "private", "other"]

PEER_WINDOW_SIZE = 2000
PEER_CHECK_EVERY = 100
PEER_MIN_LINES = 500
PEER_SHARE_ON = 0.70
PEER_SHARE_OFF = 0.50


@dataclass(frozen=True)
class PeerTransition:
    kind: Literal["cdn", "private"]
    active: bool
    share: float
    lines: int


@dataclass(frozen=True)
class PeerSummary:
    lines: int
    cdn_share: float
    private_share: float
    top_provider: str | None
    cdn_active: bool
    private_active: bool


class PeerWindow:
    def __init__(self, size: int = PEER_WINDOW_SIZE) -> None:
        self.size = size
        self._window: deque[tuple[PeerKind, str | None]] = deque()
        self._cdn = 0
        self._private = 0
        self._providers: Counter[str] = Counter()
        self._recorded = 0
        self._checked_at = 0
        self._active: dict[str, bool] = {"cdn": False, "private": False}

    def record(self, kind: PeerKind, provider: str | None = None) -> None:
        self._window.append((kind, provider))
        if kind == "cdn":
            self._cdn += 1
            if provider:
                self._providers[provider] += 1
        elif kind == "private":
            self._private += 1
        if len(self._window) > self.size:
            old_kind, old_provider = self._window.popleft()
            if old_kind == "cdn":
                self._cdn -= 1
                if old_provider:
                    self._providers[old_provider] -= 1
                    if not self._providers[old_provider]:
                        del self._providers[old_provider]
            elif old_kind == "private":
                self._private -= 1
        self._recorded += 1

    def _shares(self) -> tuple[int, float, float]:
        lines = len(self._window)
        if not lines:
            return 0, 0.0, 0.0
        return lines, self._cdn / lines, self._private / lines

    def check(self) -> list[PeerTransition]:
        if self._recorded - self._checked_at < PEER_CHECK_EVERY:
            return []
        self._checked_at = self._recorded
        lines, cdn_share, private_share = self._shares()
        transitions: list[PeerTransition] = []
        for kind, share in (("cdn", cdn_share), ("private", private_share)):
            active = self._active[kind]
            if not active and lines >= PEER_MIN_LINES and share >= PEER_SHARE_ON:
                self._active[kind] = True
                transitions.append(PeerTransition(kind, True, share, lines))  # type: ignore[arg-type]
            elif active and share < PEER_SHARE_OFF:
                self._active[kind] = False
                transitions.append(PeerTransition(kind, False, share, lines))  # type: ignore[arg-type]
        return transitions

    def summary(self) -> PeerSummary:
        lines, cdn_share, private_share = self._shares()
        top = self._providers.most_common(1)
        return PeerSummary(
            lines=lines,
            cdn_share=cdn_share,
            private_share=private_share,
            top_provider=top[0][0] if top else None,
            cdn_active=self._active["cdn"],
            private_active=self._active["private"],
        )
