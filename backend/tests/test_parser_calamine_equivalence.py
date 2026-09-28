"""Equivalence test: the new `python-calamine` reader in `app.core.parser`
vs. the retired openpyxl `read_only`/`data_only` reader it replaces.

The pre-migration implementation is frozen here as `ref_parse`/`ref_iter_chunks`
(a straight copy of the old `parser.py` body) purely as an equivalence
reference — it is NOT production code, and must not be imported elsewhere.

Covers every real workbook under `../examples/*/sources/*.xlsx` and
`../examples/*/template.xlsx` (skipped individually if the examples tree is
missing) plus a synthetic workbook covering the type matrix that real
spreadsheets exercise: ints, floats, a date, a datetime, a midnight-exact
datetime (calamine's date/datetime type is value-based, see `_normalize_cell`
in _reader_calamine.py), an empty cell mid-row, a trailing empty column, an
uncalculated formula, a bool, and a numeric-looking string.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from zipfile import BadZipFile

import pandas as pd
import pytest
from openpyxl import Workbook, load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from app.core import parser as new_parser
from app.core.exceptions import TemplateInvalid

EXAMPLES_DIR = Path(__file__).resolve().parents[2] / "examples"
DEFAULT_CHUNK_SIZE = 10000


@pytest.fixture(params=["calamine", "openpyxl"])
def xlsx_reader_backend(request, monkeypatch) -> str:
    """Run a test under both `app.core.parser` backends by monkeypatching
    `XLSX_READER` before the test body calls `new_parser` — matches
    `parser._backend()`'s call-time settings read, so the switch takes
    effect per-test with no import-time caching to fight.

    The `openpyxl` param is expected to equal `ref_parse`/`ref_iter_chunks`
    (the frozen pre-migration reference above) almost by construction: it's
    the same code moved verbatim into `app/core/_reader_openpyxl.py`. Every
    equivalence case parametrized over this fixture is therefore also the
    proof that the move was verbatim.
    """
    monkeypatch.setenv("XLSX_READER", request.param)
    return request.param


# --- frozen reference implementation (pre-calamine parser.py) ---------------


@dataclass(frozen=True)
class _RefParsedSheet:
    headers: list[str]
    df: pd.DataFrame


def _ref_normalize_header(cell: object) -> str:
    if cell is None:
        return ""
    return str(cell).strip()


def _ref_row_is_empty(row: tuple) -> bool:
    return all(cell is None or (isinstance(cell, str) and cell.strip() == "") for cell in row)


def _ref_make_sheet(headers: list[str], data_rows: list[list[object]]) -> _RefParsedSheet:
    width = len(headers)
    normalized = [list(row[:width]) + [None] * max(0, width - len(row)) for row in data_rows]
    return _RefParsedSheet(headers=headers, df=pd.DataFrame(normalized, columns=headers))


def ref_iter_chunks(
    path: str | Path, sheet: str, header_row: int, *, chunk_size: int = DEFAULT_CHUNK_SIZE
) -> Iterator[_RefParsedSheet]:
    if chunk_size < 1:
        chunk_size = DEFAULT_CHUNK_SIZE
    if header_row < 1:
        raise TemplateInvalid(user_message="標頭列號必須 ≥ 1", tech_detail=f"header_row={header_row}")

    try:
        wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    except (InvalidFileException, FileNotFoundError, OSError, BadZipFile) as exc:
        raise TemplateInvalid(
            user_message="範本檔損毀或非 xlsx 格式",
            tech_detail=f"{type(exc).__name__}: {exc}",
            path=str(path),
        ) from exc

    try:
        if sheet not in wb.sheetnames:
            raise TemplateInvalid(
                user_message=f"工作表「{sheet}」不存在",
                tech_detail=f"available sheets: {wb.sheetnames}",
                sheet=sheet,
            )
        ws = wb[sheet]
        headers: list[str] | None = None
        buffer: list[list[object]] = []
        emitted = False
        for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if i < header_row:
                continue
            if i == header_row:
                headers = [_ref_normalize_header(cell) for cell in row]
                continue
            if _ref_row_is_empty(row):
                continue
            buffer.append(list(row))
            if len(buffer) >= chunk_size:
                yield _ref_make_sheet(headers, buffer)
                emitted = True
                buffer = []

        if headers is None:
            raise TemplateInvalid(
                user_message=f"工作表「{sheet}」沒有第 {header_row} 列",
                tech_detail="header_row beyond last row in sheet",
                sheet=sheet,
                header_row=header_row,
            )

        if buffer:
            yield _ref_make_sheet(headers, buffer)
            emitted = True
        if not emitted:
            yield _ref_make_sheet(headers, [])
    finally:
        wb.close()


def ref_parse(path: str | Path, sheet: str, header_row: int) -> _RefParsedSheet:
    chunks = list(ref_iter_chunks(path, sheet, header_row, chunk_size=DEFAULT_CHUNK_SIZE))
    if len(chunks) == 1:
        return chunks[0]
    headers = chunks[0].headers
    df = pd.concat([c.df for c in chunks], ignore_index=True)
    return _RefParsedSheet(headers=headers, df=df)


# --- real example workbooks --------------------------------------------------


def _discover_example_files() -> list[Path]:
    if not EXAMPLES_DIR.exists():
        return []
    files = sorted(EXAMPLES_DIR.glob("*/sources/*.xlsx")) + sorted(EXAMPLES_DIR.glob("*/template.xlsx"))
    return [f for f in files if f.exists()]


EXAMPLE_FILES = _discover_example_files()


@pytest.mark.parametrize("path", EXAMPLE_FILES, ids=lambda p: str(p.relative_to(EXAMPLES_DIR)))
def test_real_example_equivalence(path: Path, xlsx_reader_backend) -> None:
    wb = load_workbook(filename=str(path), read_only=True)
    try:
        sheet = wb.sheetnames[0]
    finally:
        wb.close()

    ref = ref_parse(path, sheet, header_row=1)
    new = new_parser.parse(path, sheet, header_row=1)

    assert new.headers == ref.headers
    pd.testing.assert_frame_equal(new.df, ref.df)


# --- synthetic type-matrix workbook ------------------------------------------

_HEADERS = ["id", "amount", "as_of_date", "logged_at", "note", "flag", "code", "formula", "trailing"]
_ROWS = [
    [1, 10.5, dt.date(2024, 1, 15), dt.datetime(2024, 1, 15, 10, 30, 0), "first", True, "007", "=1+1", None],
    # midnight-exact datetime: calamine's date/datetime typing is value-based
    # (a whole-day serial number decodes as `date`, not `datetime`), so this
    # row specifically exercises the upgrade-to-datetime rule in
    # parser._normalize_cell.
    [2, 20.0, dt.date(2024, 2, 1), dt.datetime(2024, 2, 1, 0, 0, 0), None, False, "008", "=2+2", None],
    [3, 30, dt.date(2024, 3, 1), dt.datetime(2024, 3, 1, 9, 0, 0), "third", True, "009", "=3+3", None],
    [4, 40.25, dt.date(2024, 4, 1), dt.datetime(2024, 4, 1, 0, 0, 0), "fourth", False, "010", "=4+4", None],
    [5, 50, dt.date(2024, 5, 1), dt.datetime(2024, 5, 1, 12, 0, 0), "fifth", True, "011", "=5+5", None],
    [6, 60.75, dt.date(2024, 6, 1), dt.datetime(2024, 6, 1, 0, 0, 0), "sixth", False, "012", "=6+6", None],
    [7, 70, dt.date(2024, 7, 1), dt.datetime(2024, 7, 1, 6, 0, 0), "seventh", True, "013", "=7+7", None],
]


def _build_synthetic_workbook(tmp_path: Path) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.append(_HEADERS)
    for row in _ROWS:
        ws.append(row)
    path = tmp_path / "synthetic.xlsx"
    wb.save(path)
    return path


def test_synthetic_type_matrix_equivalence(tmp_path: Path, xlsx_reader_backend) -> None:
    path = _build_synthetic_workbook(tmp_path)

    ref = ref_parse(path, "Sheet", header_row=1)
    new = new_parser.parse(path, "Sheet", header_row=1)

    assert new.headers == ref.headers == _HEADERS

    # Explicit rule (per dispatch spec step 3): an uncalculated formula has no
    # cached value in the xlsx, so both readers must yield None for it — not
    # the formula string, and not a recomputed value.
    assert ref.df["formula"].isna().all()
    assert new.df["formula"].isna().all()

    # Trailing empty column and mid-row empty cell both come through as None
    # on both sides.
    assert ref.df["trailing"].isna().all()
    assert new.df["trailing"].isna().all()
    assert pd.isna(ref.df.loc[1, "note"])
    assert pd.isna(new.df.loc[1, "note"])

    pd.testing.assert_frame_equal(new.df, ref.df)


# --- calamine-swap equivalence gaps (found by a fresh-context verifier) -----


def test_empty_sheet_raises_same_template_invalid_as_old_reader(tmp_path: Path, xlsx_reader_backend) -> None:
    """calamine's `iter_rows()` panics (`pyo3_runtime.PanicException`, a
    `BaseException`, not catchable as `TemplateInvalid`) on a sheet with zero
    rows and zero columns. `_reader_calamine.py` must guard `height`/`width`
    before iterating so this reduces to the ordinary "header row beyond last
    row" path, matching what the openpyxl backend raises for the same input.
    """
    wb = Workbook()
    path = tmp_path / "empty.xlsx"
    wb.save(path)  # a brand-new sheet has no cells at all

    with pytest.raises(TemplateInvalid) as excinfo:
        new_parser.parse(path, "Sheet", header_row=1)
    assert excinfo.value.user_message == "工作表「Sheet」沒有第 1 列"

    assert new_parser.preview_rows(path, "Sheet") == []
    # list_sheets must still work on an empty-but-otherwise-valid workbook.
    assert new_parser.list_sheets(path) == ["Sheet"]


def test_leading_empty_columns_are_left_padded_like_old_dimension_reader(tmp_path: Path, xlsx_reader_backend) -> None:
    """Data starting at column C (two leading empty columns) must not lose
    those columns: `iter_rows()` trims them away, so `parser.py` needs to
    restore them from `sheet.start`'s column offset.
    """
    wb = Workbook()
    ws = wb.active
    ws["C1"] = "a"
    ws["D1"] = "b"
    ws["C2"] = 1
    ws["D2"] = 2
    path = tmp_path / "leading_cols.xlsx"
    wb.save(path)

    ref = ref_parse(path, "Sheet", header_row=1)
    new = new_parser.parse(path, "Sheet", header_row=1)

    assert new.headers == ref.headers == ["", "", "a", "b"]
    pd.testing.assert_frame_equal(new.df, ref.df)


def test_large_whole_number_floats_stay_float_not_int(tmp_path: Path, xlsx_reader_backend) -> None:
    """A whole-number float at or beyond 2**53 must NOT be converted to
    `int` — xlsx only stores numbers as IEEE-754 doubles, so a value that
    large already lost exact-integer precision when it was written; forcing
    it into Python's arbitrary-precision int fabricates digits that were
    never in the file, and diverges from the old reader (which also kept
    these as float).
    """
    wb = Workbook()
    ws = wb.active
    ws.append(["c"])
    ws.append([1e20])
    ws.append([1.5e16])
    path = tmp_path / "big_floats.xlsx"
    wb.save(path)

    ref = ref_parse(path, "Sheet", header_row=1)
    new = new_parser.parse(path, "Sheet", header_row=1)

    assert ref.df["c"].tolist() == [1e20, 1.5e16]
    assert new.df["c"].tolist() == [1e20, 1.5e16]
    pd.testing.assert_frame_equal(new.df, ref.df)


def test_open_calamine_maps_key_error_and_bad_zip_file_to_template_invalid(monkeypatch) -> None:
    """The old `list_sheets` caught `KeyError` and `zipfile.BadZipFile`
    alongside openpyxl's own exceptions; `_reader_calamine._open_calamine`
    must keep the same coverage even though `python-calamine` normally
    raises its own `CalamineError` subclasses for corrupt/non-xlsx input.

    Calamine-internals test — not parametrized over `xlsx_reader_backend`,
    since it monkeypatches the calamine module directly.
    """
    from app.core import _reader_calamine

    def raise_key_error(*_args, **_kwargs):
        raise KeyError("_rels/.rels")

    def raise_bad_zip(*_args, **_kwargs):
        raise BadZipFile("not a zip")

    monkeypatch.setattr(
        _reader_calamine.python_calamine.CalamineWorkbook, "from_path", staticmethod(raise_key_error)
    )
    with pytest.raises(TemplateInvalid):
        new_parser.list_sheets("whatever.xlsx")

    monkeypatch.setattr(
        _reader_calamine.python_calamine.CalamineWorkbook, "from_path", staticmethod(raise_bad_zip)
    )
    with pytest.raises(TemplateInvalid):
        new_parser.list_sheets("whatever.xlsx")


def test_synthetic_iter_chunks_matches_parse(tmp_path: Path, xlsx_reader_backend) -> None:
    path = _build_synthetic_workbook(tmp_path)

    whole = new_parser.parse(path, "Sheet", header_row=1)
    chunks = list(new_parser.iter_chunks(path, "Sheet", header_row=1, chunk_size=3))

    assert len(chunks) == 3  # 7 data rows / chunk_size 3 -> 3, 3, 1
    headers = chunks[0].headers
    assert headers == whole.headers
    concatenated = pd.concat([c.df for c in chunks], ignore_index=True)
    pd.testing.assert_frame_equal(concatenated, whole.df)


# --- known, unfixable calamine divergences (pinned, not regressions) --------


def test_known_calamine_divergences(tmp_path: Path, monkeypatch) -> None:
    """Pins the three documented divergences between the `calamine` and
    `openpyxl` backends (see `_reader_calamine`'s module docstring):

    - an error-cell string (`#DIV/0!`) comes back empty under calamine,
      unchanged under openpyxl.
    - a whitespace-only string cell (`"   "`) comes back empty under
      calamine, unchanged under openpyxl.
    - trailing columns that `ws.append()` pushed into the sheet's dimension
      but never actually wrote a value into (every row in those columns is
      `None`, including the header) are invisible under calamine — `ws.width`
      excludes them — but present (as an empty-named column of `None`s)
      under openpyxl, which reads off the `dimension` element.

    Built with `ws.append()`, matching how `tests/conftest.py::make_xlsx`
    builds every other fixture in this suite — no raw XML needed; openpyxl
    itself skips serializing untouched trailing cells while still recording
    them in the sheet's `dimension`.
    """
    wb = Workbook()
    ws = wb.active
    ws.append(["id", "err", "ws", None, None])
    ws.append([1, "#DIV/0!", "   ", None, None])
    ws.append([2, "ok", "x", None, None])
    path = tmp_path / "divergences.xlsx"
    wb.save(path)

    monkeypatch.setenv("XLSX_READER", "openpyxl")
    legacy = new_parser.parse(path, "Sheet", header_row=1)
    assert legacy.headers == ["id", "err", "ws", "", ""]
    assert legacy.df["err"].tolist() == ["#DIV/0!", "ok"]
    assert legacy.df["ws"].tolist() == ["   ", "x"]
    assert legacy.df[""].isna().all().all()  # both trailing columns, both rows

    monkeypatch.setenv("XLSX_READER", "calamine")
    fast = new_parser.parse(path, "Sheet", header_row=1)
    assert fast.headers == ["id", "err", "ws"]  # trailing columns gone entirely
    assert pd.isna(fast.df.loc[0, "err"])
    assert fast.df.loc[1, "err"] == "ok"
    assert pd.isna(fast.df.loc[0, "ws"])
    assert fast.df.loc[1, "ws"] == "x"
