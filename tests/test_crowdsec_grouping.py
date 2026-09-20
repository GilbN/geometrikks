"""Grouping active decisions into one entry per target."""
from __future__ import annotations

from typing import Any

import pytest

from geometrikks.domain.security.grouping import go_duration_seconds, group_decisions
from geometrikks.services.crowdsec import Decision


def make_decision(**overrides: Any) -> Decision:
    values: dict[str, Any] = {
        "id": 1, "origin": "crowdsec", "type": "ban", "scope": "Ip",
        "value": "1.2.3.4", "duration": "3h59m", "scenario": "crowdsecurity/http-probing",
        **overrides,
    }
    return Decision(**values)


@pytest.mark.parametrize(
    ("duration", "seconds"),
    [
        ("1h49m36s", 6576.0),
        ("30m", 1800.0),
        ("59.5s", 59.5),
        ("1h0m0.25s", 3600.25),
        ("-1h37m37s", -5857.0),
        ("350ms", 0.35),
        ("not a duration", 0.0),
    ],
)
def test_go_duration_seconds(duration: str, seconds: float):
    assert go_duration_seconds(duration) == pytest.approx(seconds)


def test_several_decisions_for_one_ip_become_one_group():
    groups = group_decisions([
        make_decision(id=1, duration="1h49m36s", scenario="crowdsecurity/http-sensitive-files"),
        make_decision(id=2, duration="1h50m33s", scenario="crowdsecurity/http-admin-interface-probing"),
        make_decision(id=3, value="5.6.7.8"),
    ])
    assert [(g.value, len(g.decisions)) for g in groups] == [("1.2.3.4", 2), ("5.6.7.8", 1)]


def test_group_lists_the_longest_lived_decision_first_and_reports_its_duration():
    (group,) = group_decisions([
        make_decision(id=1, duration="1h49m36s"),
        make_decision(id=2, duration="1h50m33s"),
        make_decision(id=3, duration="59m"),
    ])
    assert [d.id for d in group.decisions] == [2, 1, 3]
    assert group.duration == "1h50m33s"


def test_group_type_is_the_strongest_remediation():
    (group,) = group_decisions([
        make_decision(id=1, type="captcha", duration="24h"),
        make_decision(id=2, type="ban", duration="1h"),
    ])
    assert group.type == "ban"


def test_group_origins_are_distinct_in_decision_order():
    (group,) = group_decisions([
        make_decision(id=1, origin="crowdsec", duration="3h"),
        make_decision(id=2, origin="cscli", duration="2h"),
        make_decision(id=3, origin="crowdsec", duration="1h"),
    ])
    assert group.origins == ["crowdsec", "cscli"]


def test_same_value_under_different_scopes_stays_apart():
    groups = group_decisions([
        make_decision(id=1, scope="Country", value="CN"),
        make_decision(id=2, scope="AS", value="CN"),
    ])
    assert [(g.scope, g.value) for g in groups] == [("Country", "CN"), ("AS", "CN")]


def test_ip_spellings_of_one_address_share_a_group():
    (group,) = group_decisions([
        make_decision(id=1, value="2001:db8::1"),
        make_decision(id=2, value="2001:0db8:0:0:0:0:0:1"),
    ])
    assert group.value == "2001:db8::1"
    assert len(group.decisions) == 2


def test_groups_keep_the_order_the_lapi_first_mentioned_them():
    groups = group_decisions([
        make_decision(id=1, value="9.9.9.9"),
        make_decision(id=2, value="1.1.1.1"),
        make_decision(id=3, value="9.9.9.9"),
    ])
    assert [g.value for g in groups] == ["9.9.9.9", "1.1.1.1"]
