"""FileSource: tailing, rotation, missing-file state and the tail read."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import aiofiles
import aiofiles.os
import pytest

from geometrikks.services.logsources import FileSource, LogSource, SourceStatus

pytestmark = pytest.mark.anyio


def make_source(path: Path, **kwargs) -> FileSource:
    kwargs.setdefault("poll_interval", 0.01)
    return FileSource(path, **kwargs)


async def next_line(gen) -> str:
    return await asyncio.wait_for(gen.__anext__(), timeout=5.0)


def test_file_source_satisfies_the_protocol(tmp_path: Path) -> None:
    source: LogSource = make_source(tmp_path / "a.log")
    assert source.kind == "file"
    assert source.label == str(tmp_path / "a.log")
    assert source.status() == SourceStatus(available=True)


async def test_lines_from_start_yields_existing_lines(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("one\ntwo\n", encoding="utf-8")
    gen = make_source(log, start_at_end=False).lines(asyncio.Event())

    assert await next_line(gen) == "one\n"
    assert await next_line(gen) == "two\n"
    await gen.aclose()


async def test_lines_start_at_end_skips_existing_lines(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("old\n", encoding="utf-8")
    gen = make_source(log).lines(asyncio.Event())

    pending = asyncio.ensure_future(next_line(gen))
    await asyncio.sleep(0.05)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("new\n")

    assert await pending == "new\n"
    await gen.aclose()


async def test_lines_ends_when_stop_is_set(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")
    stop = asyncio.Event()
    gen = make_source(log).lines(stop)

    pending = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.05)
    stop.set()

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(pending, timeout=2.0)


async def test_lines_survive_undecodable_bytes(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_bytes(b"ok \xff\xfe line\n")
    gen = make_source(log, start_at_end=False).lines(asyncio.Event())

    line = await next_line(gen)

    assert line.startswith("ok ") and line.endswith(" line\n")
    await gen.aclose()


async def test_lines_survive_the_file_vanishing_before_open(tmp_path: Path, monkeypatch) -> None:
    log = tmp_path / "a.log"
    log.write_text("one\n", encoding="utf-8")
    source = make_source(log, start_at_end=False)
    real_open = aiofiles.open
    calls = {"n": 0}

    def flaky_open(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise FileNotFoundError("gone between stat and open")
        return real_open(*args, **kwargs)

    monkeypatch.setattr(aiofiles, "open", flaky_open)
    gen = source.lines(asyncio.Event())

    assert await next_line(gen) == "one\n"
    assert calls["n"] == 2
    assert source.status() == SourceStatus(available=True)
    await gen.aclose()


async def test_rotation_reopens_from_start_twice(tmp_path: Path) -> None:
    """Two consecutive real rotations (inode change) keep lines flowing, reading each new file from the start."""
    log = tmp_path / "access.log"
    log.write_text("first\n", encoding="utf-8")
    gen = make_source(log, start_at_end=False).lines(asyncio.Event())

    assert await next_line(gen) == "first\n"
    for i in (1, 2):
        replacement = tmp_path / f"rotated-{i}.log"
        replacement.write_text(f"rotated {i}\n", encoding="utf-8")
        os.replace(replacement, log)  # atomically swaps in a new inode
        assert await next_line(gen) == f"rotated {i}\n"
    await gen.aclose()


async def test_is_rotated_truncation_99pct(tmp_path: Path, monkeypatch) -> None:
    """Rotation detected when size shrinks by >=99%."""
    log = tmp_path / "access.log"
    log.write_bytes(b"x" * 1_000_000)
    prev = os.stat(log)

    class Curr:
        st_size = 5_000
        st_ino = prev.st_ino

    async def fake_stat(_path):
        return Curr()

    monkeypatch.setattr(aiofiles.os, "stat", fake_stat)
    assert await make_source(log)._is_rotated(prev) is True


async def test_is_rotated_inode_change(tmp_path: Path, monkeypatch) -> None:
    """Rotation detected when inode changes."""
    log = tmp_path / "access.log"
    log.write_bytes(b"x" * 1_000_000)
    prev = os.stat(log)

    class Curr:
        st_size = prev.st_size
        st_ino = prev.st_ino + 1

    async def fake_stat(_path):
        return Curr()

    monkeypatch.setattr(aiofiles.os, "stat", fake_stat)
    assert await make_source(log)._is_rotated(prev) is True


async def test_is_rotated_disabled(tmp_path: Path, monkeypatch) -> None:
    """Rotation check can be disabled via env."""
    monkeypatch.setenv("DISABLE_ROTATION_CHECK", "true")
    log = tmp_path / "access.log"
    log.write_bytes(b"x" * 1_000_000)
    prev = os.stat(log)

    class Curr:
        st_size = 100
        st_ino = prev.st_ino + 100

    async def fake_stat(_path):
        return Curr()

    monkeypatch.setattr(aiofiles.os, "stat", fake_stat)
    assert await make_source(log)._is_rotated(prev) is False


async def test_wait_ready_reports_missing_then_recovers(tmp_path: Path) -> None:
    """DISABLE_WAIT=true (conftest) makes the grace wait return immediately."""
    log = tmp_path / "missing.log"
    source = make_source(log)
    stop = asyncio.Event()

    ready = asyncio.ensure_future(source.wait_ready(stop))
    await asyncio.sleep(0.05)
    assert source.status() == SourceStatus(available=False, reason="missing")

    log.write_text("", encoding="utf-8")
    assert await asyncio.wait_for(ready, timeout=2.0) is True
    assert source.status() == SourceStatus(available=True)


async def test_wait_ready_returns_false_when_stopped(tmp_path: Path) -> None:
    source = make_source(tmp_path / "missing.log")
    stop = asyncio.Event()

    ready = asyncio.ensure_future(source.wait_ready(stop))
    await asyncio.sleep(0.05)
    stop.set()

    assert await asyncio.wait_for(ready, timeout=2.0) is False


async def test_mid_flight_deletion_flags_missing_and_recovers(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("", encoding="utf-8")
    source = make_source(log)
    gen = source.lines(asyncio.Event())
    pending = asyncio.ensure_future(next_line(gen))
    await asyncio.sleep(0.05)

    log.unlink()
    for _ in range(100):
        if not source.status().available:
            break
        await asyncio.sleep(0.02)
    assert source.status() == SourceStatus(available=False, reason="missing")

    log.write_text("back\n", encoding="utf-8")
    assert await pending == "back\n"
    assert source.status() == SourceStatus(available=True)
    await gen.aclose()


async def test_recent_lines_returns_the_last_lines(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("".join(f"line {i}\n" for i in range(10)), encoding="utf-8")

    assert await make_source(log).recent_lines(3) == ["line 7\n", "line 8\n", "line 9\n"]


async def test_recent_lines_short_file(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("only\n", encoding="utf-8")

    assert await make_source(log).recent_lines(3) == ["only\n"]


async def test_recent_lines_empty_and_missing_file(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    assert await make_source(log).recent_lines(3) == []
    log.write_text("", encoding="utf-8")
    assert await make_source(log).recent_lines(3) == []


async def test_recent_lines_without_trailing_newline(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("a\nb\nc\nd", encoding="utf-8")

    assert await make_source(log).recent_lines(3) == ["b\n", "c\n", "d"]


async def test_recent_lines_crlf(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_bytes(b"a\r\nb\r\nc\r\nd\r\n")

    # Text-mode semantics, the same as lines() and the read this replaces.
    assert await make_source(log).recent_lines(2) == ["c\n", "d\n"]


async def test_recent_lines_only_break_on_newlines(tmp_path: Path) -> None:
    """U+2028 is legal inside a JSON string and must not split the line."""
    log = tmp_path / "a.log"
    log.write_text('{"ua": "a\u2028b"}\n{"ua": "c\x0bd"}\n', encoding="utf-8")

    assert await make_source(log).recent_lines(3) == [
        '{"ua": "a\u2028b"}\n',
        '{"ua": "c\x0bd"}\n',
    ]


async def test_recent_lines_survive_undecodable_bytes(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_bytes(b"a \xff\nb \xfe\n")

    lines = await make_source(log).recent_lines(3)

    assert len(lines) == 2 and lines[0].startswith("a ") and lines[1].startswith("b ")


async def test_recent_lines_returns_whole_lines_longer_than_a_block(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    long_line = "x" * 20_000
    log.write_text(f"head\n{long_line}\ntail\n", encoding="utf-8")

    assert await make_source(log).recent_lines(2) == [long_line + "\n", "tail\n"]
