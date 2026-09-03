"""Crash-safety tests for `app/core/atomic_io.py`: no partial writes, no
leftover tmp files, and overwrite semantics."""

from __future__ import annotations

import pytest

from app.core.atomic_io import atomic_path, atomic_write_text


def _tmp_siblings(path):
    return list(path.parent.glob(".tmp-*"))


def test_atomic_path_exception_leaves_no_final_and_no_tmp(tmp_path):
    target = tmp_path / "out.bin"

    with pytest.raises(RuntimeError):
        with atomic_path(target) as tmp:
            tmp.write_bytes(b"partial")
            raise RuntimeError("boom")

    assert not target.exists()
    assert _tmp_siblings(target) == []


def test_atomic_path_success_writes_final_content(tmp_path):
    target = tmp_path / "out.bin"

    with atomic_path(target) as tmp:
        tmp.write_bytes(b"final content")

    assert target.read_bytes() == b"final content"
    assert _tmp_siblings(target) == []


def test_atomic_path_writer_produces_no_file_raises(tmp_path):
    target = tmp_path / "out.bin"

    with pytest.raises(RuntimeError, match="produced no file"):
        with atomic_path(target):
            pass  # writer never touched `tmp`

    assert not target.exists()
    assert _tmp_siblings(target) == []


def test_atomic_write_text_overwrites_existing_file(tmp_path):
    target = tmp_path / "state.json"
    target.write_text("old", encoding="utf-8")

    atomic_write_text(target, "new")

    assert target.read_text(encoding="utf-8") == "new"
    assert _tmp_siblings(target) == []
