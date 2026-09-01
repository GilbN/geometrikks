"""Rolling peer-kind window: counts, eviction, hysteresis."""
from __future__ import annotations

from geometrikks.services.logparser.peer_window import (
    PEER_MIN_LINES, PEER_SHARE_OFF, PEER_SHARE_ON, PeerWindow,
)


def fill(window: PeerWindow, kind, n: int, provider=None) -> None:
    for _ in range(n):
        window.record(kind, provider)


def test_shares_over_window_length() -> None:
    w = PeerWindow(size=100)
    fill(w, "cdn", 30, "Cloudflare")
    fill(w, "private", 10)
    fill(w, "other", 10)
    s = w.summary()
    assert s.lines == 50
    assert s.cdn_share == 0.6
    assert s.private_share == 0.2
    assert s.top_provider == "Cloudflare"


def test_eviction_keeps_counts_and_providers_in_step() -> None:
    w = PeerWindow(size=10)
    fill(w, "cdn", 10, "Fastly")
    fill(w, "other", 10)          # evicts every Fastly line
    s = w.summary()
    assert s.lines == 10
    assert s.cdn_share == 0.0
    assert s.top_provider is None


def test_top_provider_is_most_frequent() -> None:
    w = PeerWindow(size=100)
    fill(w, "cdn", 3, "Fastly")
    fill(w, "cdn", 5, "Cloudflare")
    assert w.summary().top_provider == "Cloudflare"


def test_check_is_quiet_between_intervals() -> None:
    w = PeerWindow(size=2000)
    fill(w, "cdn", 99, "Cloudflare")
    assert w.check() == []        # 99 recorded, interval is 100


def test_activates_at_threshold_with_min_lines() -> None:
    w = PeerWindow(size=2000)
    fill(w, "cdn", 499, "Cloudflare")
    w.check()
    assert not w.summary().cdn_active, "499 lines is below the floor"
    fill(w, "cdn", 101, "Cloudflare")
    transitions = w.check()
    assert [t.kind for t in transitions] == ["cdn"]
    assert transitions[0].active is True
    assert transitions[0].share == 1.0
    assert w.summary().cdn_active


def test_does_not_activate_below_share() -> None:
    w = PeerWindow(size=2000)
    fill(w, "cdn", 690, "Cloudflare")   # 69% of 1000
    fill(w, "other", 310)
    w.check()
    assert not w.summary().cdn_active


def test_hysteresis_clears_below_off_not_between() -> None:
    w = PeerWindow(size=1000)
    fill(w, "private", 800)
    fill(w, "other", 200)
    w.check()
    assert w.summary().private_active
    # Dilute to 55%: eviction drops 250 private lines (550/450). Between
    # OFF (50%) and ON (70%) stays active.
    fill(w, "other", 250)
    w.check()
    assert w.summary().private_active
    # Below 50% clears (400/600), and the transition is reported once.
    fill(w, "other", 150)
    transitions = w.check()
    assert any(t.kind == "private" and t.active is False for t in transitions)
    assert not w.summary().private_active


def test_transition_reported_once_per_crossing() -> None:
    w = PeerWindow(size=2000)
    fill(w, "cdn", 600, "Cloudflare")
    first = w.check()
    fill(w, "cdn", 100, "Cloudflare")
    second = w.check()
    assert len(first) == 1 and second == []
