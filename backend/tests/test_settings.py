"""Settings validation: `XLSX_READER` backend selection."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.settings import Settings


def test_xlsx_reader_defaults_to_calamine(monkeypatch):
    monkeypatch.delenv("XLSX_READER", raising=False)
    assert Settings().xlsx_reader == "calamine"


def test_xlsx_reader_env_selects_openpyxl(monkeypatch):
    monkeypatch.setenv("XLSX_READER", "openpyxl")
    assert Settings().xlsx_reader == "openpyxl"


def test_xlsx_reader_rejects_unknown_value(monkeypatch):
    monkeypatch.setenv("XLSX_READER", "foo")
    with pytest.raises(ValidationError):
        Settings()
