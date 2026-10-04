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


async def test_a_rotation_while_old_lines_are_unread_is_still_detected(tmp_path: Path) -> None:
    log = tmp_path / "access.log"
    log.write_text("old-one\nold-two\n", encoding="utf-8")
    gen = make_source(log, start_at_end=False).lines(asyncio.Event())

    assert await next_line(gen) == "old-one\n"
    os.rename(log, tmp_path / "access.log.1")
    log.write_text("new-one\n", encoding="utf-8")
    assert await next_line(gen) == "old-two\n"
    assert await next_line(gen) == "new-one\n"
    await gen.aclose()


async def test_is_rotated_truncation_99pct(tmp_path: Path, monkeypatch) -> None:
    """Rotation detected when size shrinks by >=99%."""
    # Create file and obtain real previous stat
    log = tmp_path / "access.log"
    log.write_bytes(b"x" * 1_000_000)
    prev = os.stat(log)

    # Current stat: shrunk to 5_000 bytes (~99.5% drop) and same inode
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

    # Even with drastic change, returns False when disabled
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


async def test_recent_lines_clears_a_stale_missing_flag(tmp_path: Path, caplog) -> None:
    """A source restarted in-process can still carry the flag from before
    it stopped; a read that works proves the file is readable."""
    caplog.set_level("INFO")
    log = tmp_path / "a.log"
    log.write_text("one\n", encoding="utf-8")
    source = make_source(log)
    source._missing = True

    assert await source.recent_lines(3) == ["one\n"]
    assert source.status() == SourceStatus(available=True)
    assert sum("reappeared" in r.getMessage() for r in caplog.records) == 1


async def test_recent_lines_marks_the_source_missing_when_the_read_fails(tmp_path: Path, monkeypatch, caplog) -> None:
    log = tmp_path / "a.log"
    log.write_text("one\n", encoding="utf-8")
    source = make_source(log)

    def unreadable(count: int) -> list[str]:
        raise PermissionError("not readable")

    monkeypatch.setattr(source, "_read_recent", unreadable)

    assert await source.recent_lines(3) == []
    assert source.status() == SourceStatus(available=False, reason="missing")
    assert sum("no longer exists or cannot be read" in r.getMessage() for r in caplog.records) == 1


async def test_unopenable_file_stays_missing_and_logs_once(tmp_path: Path, monkeypatch, caplog) -> None:
    """A file that stats but cannot be opened must not flap between
    missing and present on every poll."""
    caplog.set_level("INFO")
    log = tmp_path / "a.log"
    log.write_text("one\n", encoding="utf-8")
    source = make_source(log, start_at_end=False)
    real_open = aiofiles.open
    allow = {"open": False}

    def guarded_open(*args, **kwargs):
        if not allow["open"]:
            raise PermissionError("not readable")
        return real_open(*args, **kwargs)

    monkeypatch.setattr(aiofiles, "open", guarded_open)
    gen = source.lines(asyncio.Event())
    pending = asyncio.ensure_future(next_line(gen))

    await asyncio.sleep(0.2)  # many poll intervals
    assert source.status() == SourceStatus(available=False, reason="missing")
    messages = [r.getMessage() for r in caplog.records]
    assert sum("no longer exists or cannot be read" in m for m in messages) == 1
    assert not any("reappeared" in m for m in messages)

    allow["open"] = True
    assert await pending == "one\n"
    assert source.status() == SourceStatus(available=True)
    assert sum("reappeared" in r.getMessage() for r in caplog.records) == 1
    await gen.aclose()


async def test_recent_lines_zero_or_negative_count(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("a\nb\n", encoding="utf-8")

    assert await make_source(log).recent_lines(0) == []
    assert await make_source(log).recent_lines(-1) == []


async def test_lines_yields_a_line_written_after_wait_ready(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("old\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()

    assert await source.wait_ready(stop)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("during-wait\n")
    gen = source.lines(stop)

    assert await next_line(gen) == "during-wait\n"
    await gen.aclose()


async def test_lines_reads_from_start_when_rotated_after_wait_ready(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("old-one\nold-two\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()

    assert await source.wait_ready(stop)
    os.rename(log, tmp_path / "a.log.1")
    log.write_text("fresh\n", encoding="utf-8")
    gen = source.lines(stop)

    assert await next_line(gen) == "fresh\n"
    await gen.aclose()


async def test_lines_reads_from_start_when_truncated_after_wait_ready(tmp_path: Path) -> None:
    log = tmp_path / "a.log"
    log.write_text("old-one\nold-two\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()

    assert await source.wait_ready(stop)
    with open(log, "w", encoding="utf-8") as fh:
        fh.write("new\n")
    gen = source.lines(stop)

    assert await next_line(gen) == "new\n"
    await gen.aclose()


async def test_lines_survives_a_truncate_and_rewrite_past_the_recorded_size(
    tmp_path: Path,
) -> None:
    """Indistinguishable from an append: the read starts mid-file and must not crash."""
    log = tmp_path / "a.log"
    log.write_text("old\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()

    assert await source.wait_ready(stop)
    with open(log, "w", encoding="utf-8") as fh:
        fh.write("aaaa\nbbbb\n")
    gen = source.lines(stop)

    assert await next_line(gen) == "\n"
    assert await next_line(gen) == "bbbb\n"
    await gen.aclose()


async def test_first_open_judges_the_file_it_opened(tmp_path: Path, monkeypatch) -> None:
    """A rotation between the stat and the open must not seek into the new file."""
    log = tmp_path / "a.log"
    log.write_text("old-one\nold-two\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()
    assert await source.wait_ready(stop)

    real_open = aiofiles.open
    rotated = False

    def rotate_then_open(*args, **kwargs):
        nonlocal rotated
        if not rotated:
            rotated = True
            os.rename(log, tmp_path / "a.log.1")
            log.write_text("fresh-one\nfresh-two-is-longer\n", encoding="utf-8")
        return real_open(*args, **kwargs)

    monkeypatch.setattr(aiofiles, "open", rotate_then_open)
    gen = source.lines(stop)

    assert await next_line(gen) == "fresh-one\n"
    await gen.aclose()


async def test_the_recorded_position_survives_a_failed_first_open(
    tmp_path: Path, monkeypatch
) -> None:
    log = tmp_path / "a.log"
    log.write_text("one\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()
    assert await source.wait_ready(stop)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("two\n")

    real_open = aiofiles.open
    failed = False

    def fail_once_then_open(*args, **kwargs):
        nonlocal failed
        if not failed:
            failed = True
            raise PermissionError("denied once")
        return real_open(*args, **kwargs)

    monkeypatch.setattr(aiofiles, "open", fail_once_then_open)
    gen = source.lines(stop)

    assert await next_line(gen) == "two\n"
    assert failed
    await gen.aclose()


async def test_wait_ready_replaces_a_position_recorded_before_a_restart(
    tmp_path: Path,
) -> None:
    log = tmp_path / "a.log"
    log.write_text("one\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()

    assert await source.wait_ready(stop)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("two\n")
    assert await source.wait_ready(stop)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("three\n")
    gen = source.lines(stop)

    assert await next_line(gen) == "three\n"
    await gen.aclose()


async def test_a_second_lines_call_without_wait_ready_starts_at_the_end(
    tmp_path: Path, monkeypatch
) -> None:
    log = tmp_path / "a.log"
    log.write_text("one\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()

    assert await source.wait_ready(stop)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("two\n")
    first = source.lines(stop)
    assert await next_line(first) == "two\n"
    await first.aclose()

    real_open = aiofiles.open
    seeked = asyncio.Event()

    async def open_signalling_seek(*args, **kwargs):
        file = await real_open(*args, **kwargs)
        real_seek = file.seek

        async def seek(*seek_args, **seek_kwargs):
            position = await real_seek(*seek_args, **seek_kwargs)
            seeked.set()
            return position

        file.seek = seek
        return file

    monkeypatch.setattr(aiofiles, "open", open_signalling_seek)
    second = source.lines(stop)
    pending = asyncio.ensure_future(next_line(second))
    await asyncio.wait_for(seeked.wait(), timeout=5.0)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("three\n")
    assert await pending == "three\n"
    await second.aclose()


@pytest.mark.parametrize("recorded", [False, True])
async def test_a_path_replaced_between_stat_and_open_is_not_read_twice(
    tmp_path: Path, monkeypatch, recorded: bool
) -> None:
    log = tmp_path / "a.log"
    log.write_text("old-one\nold-two\n", encoding="utf-8")
    source = make_source(log)
    stop = asyncio.Event()
    if recorded:
        assert await source.wait_ready(stop)

    real_open = aiofiles.open
    rotated = False

    def rotate_then_open(*args, **kwargs):
        nonlocal rotated
        if not rotated:
            rotated = True
            os.rename(log, tmp_path / "a.log.1")
            log.write_text("fresh\n", encoding="utf-8")
        return real_open(*args, **kwargs)

    monkeypatch.setattr(aiofiles, "open", rotate_then_open)
    gen = source.lines(stop)
    pending = asyncio.ensure_future(next_line(gen))
    if recorded:
        assert await pending == "fresh\n"
        pending = asyncio.ensure_future(next_line(gen))

    # A reopen from byte 0 would yield "fresh" again within a poll or two.
    done, _ = await asyncio.wait({pending}, timeout=0.3)
    assert not done
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("later\n")

    assert await pending == "later\n"
    await gen.aclose()
