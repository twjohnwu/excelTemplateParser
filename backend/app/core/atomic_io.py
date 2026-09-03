"""Crash-safe file writes: write to a sibling tmp file, fsync, then
`os.replace` onto the destination.

`os.replace` is atomic on POSIX, so a `kill -9` mid-write leaves the
destination either absent (first write) or holding its previous, complete
contents (overwrite) — never a half-written state.json / xlsx / zip.
"""

from __future__ import annotations

import contextlib
import os
import secrets
from pathlib import Path
from typing import Iterator


def _tmp_path(path: Path) -> Path:
    return path.parent / f".tmp-{os.getpid()}-{secrets.token_hex(4)}"


def atomic_write_text(path: Path, text: str) -> None:
    """Write `text` to `path` atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path(path)
    try:
        tmp.write_text(text, encoding="utf-8")
        with open(tmp, "rb") as fh:
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


@contextlib.contextmanager
def atomic_path(path: Path) -> Iterator[Path]:
    """Yield a tmp path in `path`'s directory; on clean exit, fsync it and
    `os.replace` it onto `path`. On exception, delete the tmp file and
    re-raise — `path` itself is left untouched.

    Use this for writers (openpyxl `wb.save`, `zipfile.ZipFile`) that need a
    real filesystem path to write to, rather than text content in memory.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path(path)
    try:
        yield tmp
        if not tmp.exists():
            raise RuntimeError("atomic_path: writer produced no file")
        with open(tmp, "rb") as fh:
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _fsync_dir(directory: Path) -> None:
    """fsync a directory so the rename itself survives a crash.

    `os.replace` alone is atomic but the directory entry update can still be
    lost on power loss without this; some filesystems (notably older macOS
    ones) reject O_RDONLY fsync on a directory, so failures are swallowed —
    best-effort durability, not a correctness requirement of `atomic_path`.
    """
    try:
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass
