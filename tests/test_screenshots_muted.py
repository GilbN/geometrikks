"""The Muted IPs fixture for the screenshot run."""

import json
import re
from datetime import timedelta
from pathlib import Path

from tests.screenshots.muted import MUTED_ENTRIES, MutedEntry, entry_problems


def test_fixture_entries_pass_the_app_s_rules_and_stay_in_documentation_space() -> None:
    assert entry_problems() == []


def test_entry_problems_name_each_refusal() -> None:
    entries = (
        MutedEntry(network="198.51.100.7/24", note="host bits", age=timedelta(hours=1)),
        MutedEntry(network="100.64.0.0/10", note="shared space", age=timedelta(hours=1)),
        MutedEntry(network="2001:db8:1::/48", note="x" * 101, age=timedelta(hours=1)),
    )
    assert entry_problems(entries) == [
        "198.51.100.7/24 is not a network address",
        "100.64.0.0/10 lies outside the documentation ranges",
        "the note for 2001:db8:1::/48 is over 100 characters",
    ]
    assert entry_problems(entries[2:] * 21)[0] == "21 entries, over the app's limit of 20"


def test_the_scene_waits_for_every_fixture_note() -> None:
    scenes = (Path(__file__).parent / "screenshots" / "scenes.ts").read_text()
    match = re.search(r"export const MUTED_NOTES = (\[[^\]]*\])", scenes)
    assert match and json.loads(match.group(1)) == [entry.note for entry in MUTED_ENTRIES]
