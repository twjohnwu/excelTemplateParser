"""`python-calamine` backend for `parser.py` (default, `XLSX_READER=calamine`).

Calamine has no chunked/streaming read mode of its own — it loads the whole
sheet into its Rust-side structures up front — so it's only the DataFrame
build that stays bounded: `iter_chunks` walks calamine's already-loaded rows
in bounded-size batches and only ever holds one batch as a `pd.DataFrame` at
a time, keeping pandas' memory bounded even though the sheet itself is fully
resident in memory beneath it.

Known, unfixable divergences from `_reader_openpyxl` (see `_normalize_cell`
and `_iter_padded_rows` below for the mechanics; pinned by
`tests/test_parser_calamine_equivalence.py::test_known_calamine_divergences`):
error cells (`#DIV/0!` etc.) come back empty instead of the error text,
whitespace-only string cells come back empty instead of the whitespace, and
trailing columns the xlsx `dimension` element declares but never actually
writes a cell into are invisible (calamine sizes `ws.width` off written
cells, not the declared dimension).
"""

from __future__ import annotations

import datetime as dt
import zipfile
from collections.abc import Iterator
from pathlib import Path

import python_calamine

from .exceptions import TemplateInvalid
from .parser import DEFAULT_CHUNK_SIZE, ParsedSheet, _make_sheet, _normalize_header, _row_is_empty


def _open_calamine(path: str | Path) -> python_calamine.CalamineWorkbook:
    try:
        return python_calamine.CalamineWorkbook.from_path(str(path))
    except (
        python_calamine.CalamineError,
        FileNotFoundError,
        OSError,
        KeyError,
        zipfile.BadZipFile,
    ) as exc:
        raise TemplateInvalid(
            user_message="範本檔損毀或非 xlsx 格式",
            tech_detail=f"{type(exc).__name__}: {exc}",
            path=str(path),
        ) from exc


def _get_sheet(wb: python_calamine.CalamineWorkbook, sheet: str) -> python_calamine.CalamineSheet:
    if sheet not in wb.sheet_names:
        raise TemplateInvalid(
            user_message=f"工作表「{sheet}」不存在",
            tech_detail=f"available sheets: {wb.sheet_names}",
            sheet=sheet,
        )
    return wb.get_sheet_by_name(sheet)


def list_sheets(path: str | Path) -> list[str]:
    wb = _open_calamine(path)
    try:
        return list(wb.sheet_names)
    finally:
        wb.close()


def preview_rows(path: str | Path, sheet: str, *, start: int = 1, count: int = 30) -> list[list[object]]:
    wb = _open_calamine(path)
    try:
        ws = _get_sheet(wb, sheet)
        out: list[list[object]] = []
        if ws.height == 0 or ws.width == 0:
            return out
        for i, row in enumerate(_iter_padded_rows(ws), start=1):
            if i < start:
                continue
            out.append([_normalize_cell(cell) for cell in row])
            if len(out) >= count:
                break
        return out
    finally:
        wb.close()


def iter_chunks(
    path: str | Path, sheet: str, header_row: int, *, chunk_size: int = DEFAULT_CHUNK_SIZE
) -> Iterator[ParsedSheet]:
    if chunk_size < 1:
        chunk_size = DEFAULT_CHUNK_SIZE
    if header_row < 1:
        raise TemplateInvalid(
            user_message="標頭列號必須 ≥ 1",
            tech_detail=f"header_row={header_row}",
        )

    wb = _open_calamine(path)

    try:
        ws = _get_sheet(wb, sheet)
        headers: list[str] | None = None
        buffer: list[list[object]] = []
        emitted = False
        if ws.height and ws.width:
            for i, row in enumerate(_iter_padded_rows(ws), start=1):
                row = [_normalize_cell(cell) for cell in row]
                if i < header_row:
                    continue
                if i == header_row:
                    headers = [_normalize_header(cell) for cell in row]
                    continue
                if _row_is_empty(row):
                    continue
                buffer.append(list(row))
                if len(buffer) >= chunk_size:
                    yield _make_sheet(headers, buffer)
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
            yield _make_sheet(headers, buffer)
            emitted = True
        if not emitted:
            yield _make_sheet(headers, [])
    finally:
        wb.close()


def _iter_padded_rows(ws: python_calamine.CalamineSheet) -> Iterator[list[object]]:
    """Yield each row of `ws`, left-padded with `None` for a leading empty
    column area.

    `iter_rows()` trims blank leading/trailing *columns* down to
    `ws.start[1]..ws.start[1] + ws.width`, so data starting at column C loses
    its two leading columns entirely — unlike leading blank *rows*, which
    `iter_rows()` already preserves as placeholder rows (verified: a sheet
    whose data starts at row 3 still yields two blank rows first). Restoring
    the column offset keeps column positions aligned with the old
    dimension-based openpyxl reader.

    Caller must guard `ws.height == 0` / `ws.width == 0` before iterating —
    calamine's `iter_rows()` raises a Rust `pyo3_runtime.PanicException` (not
    a catchable Python exception subclass) on a genuinely empty sheet.
    """
    col_offset = ws.start[1] if ws.start is not None else 0
    if not col_offset:
        yield from ws.iter_rows()
        return
    for row in ws.iter_rows():
        yield [None] * col_offset + list(row)


def _normalize_cell(value: object) -> object:
    """Reconcile calamine's value types with what openpyxl's read_only,
    data_only reader used to produce, so downstream code (and the
    equivalence test) sees identical cells:

    - calamine pads short/empty cells with `""`; openpyxl uses `None`.
    - calamine returns every whole number as `float` (e.g. `5.0`); openpyxl's
      read_only reader collapses whole-number cells to `int` when the XML
      stored them without a decimal point. Calamine's float-only
      representation can't recover that per-cell distinction, so this only
      converts within `abs(value) < 2**53` — the range a float represents
      exactly, matching what an int-typed cell would have round-tripped to
      anyway. Above that, xlsx itself only stores numbers as IEEE-754
      doubles, so openpyxl's own textual re-parse also stays float (e.g.
      `1e20`, `1.5e16`) — converting those to Python's arbitrary-precision
      int would fabricate false precision that was never in the file.
    - calamine reports a datetime whose time-of-day is exactly midnight as a
      bare `datetime.date`; openpyxl's read_only reader always returns
      `datetime.datetime` for date/datetime-typed cells, so upgrade it back.
    - an uncalculated formula has no cached value: calamine yields `""`,
      which the empty-cell rule above already turns into `None` — the same
      value openpyxl's data_only reader yields for it.
    - an error cell (`#DIV/0!`, `#N/A`, ...) has no numeric/text value either:
      calamine yields `""` here too, which the same rule turns into `None`
      — openpyxl's data_only reader returns the error string instead. Not
      fixable from calamine's value alone: it doesn't distinguish "error
      cell" from "empty cell" (`XLSX_READER=openpyxl` keeps the error text).
    """
    if value == "":
        return None
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return int(value)
    if isinstance(value, dt.date) and not isinstance(value, dt.datetime):
        return dt.datetime(value.year, value.month, value.day)
    return value
