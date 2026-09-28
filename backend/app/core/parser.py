"""Excel parsing: workbook → DataFrame + header info.

Two interchangeable backends live behind this module: `_reader_calamine`
(default, via `python-calamine` — a Rust reader, roughly 2x faster than
openpyxl's read_only iteration on large sheets) and `_reader_openpyxl` (the
pre-calamine implementation, kept verbatim as a fallback). Pick one with
`XLSX_READER=calamine|openpyxl` (see `app.settings.Settings.xlsx_reader`);
the setting is read fresh on every call via `_backend()`, not cached at
import time, so tests can monkeypatch it per case.

calamine has three known, unfixable divergences from the old openpyxl
reader — see `_reader_calamine._normalize_cell` and the module docstring
there for the mechanics: error cells (`#DIV/0!` etc.) come back empty
instead of the error text, whitespace-only string cells come back empty
instead of the whitespace, and trailing columns the xlsx `dimension` element
declares but never actually writes a cell into are invisible (calamine sizes
`ws.width` off written cells, not the declared dimension). `openpyxl` keeps
the old exact per-cell semantics for anyone who needs them.

`iter_chunks` streams a sheet in bounded-size batches so a large primary file
never fully materializes as a `pd.DataFrame`. `parse` is a convenience
wrapper that concatenates those chunks into one DataFrame — fine for small
lookup tables, but the worker streams the primary through `iter_chunks`.
Writing (writer.py) stays on openpyxl regardless of `XLSX_READER` — calamine
is read-only.

Raises TemplateInvalid for any structural problem (corrupt file, missing
sheet, header row out of range).
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from ..settings import get_settings

DEFAULT_CHUNK_SIZE = 10000


@dataclass(frozen=True)
class ParsedSheet:
    """Result of parsing one sheet of a workbook."""

    headers: list[str]
    df: pd.DataFrame


def _backend():
    """Select the reader backend named by `settings.xlsx_reader`.

    Imported lazily (not at module top level) so `parser.py` never depends
    on either backend module at its own import time — that keeps this a
    one-way dependency (backends import shared helpers from here) instead
    of a circular one, and it means the setting is genuinely read at call
    time: a test can `monkeypatch.setenv("XLSX_READER", ...)` between calls
    and see it take effect immediately.
    """
    reader = get_settings().xlsx_reader
    if reader == "openpyxl":
        from . import _reader_openpyxl as backend
    else:
        from . import _reader_calamine as backend
    return backend


def list_sheets(path: str | Path) -> list[str]:
    """Return sheet names in the workbook (cheap; no row scan)."""
    return _backend().list_sheets(path)


def preview_rows(path: str | Path, sheet: str, *, start: int = 1, count: int = 30) -> list[list[object]]:
    """Return the first `count` rows of `sheet` starting from `start` (1-indexed).

    Used by the templates parse endpoint to power the sheet/header_row picker.
    """
    return _backend().preview_rows(path, sheet, start=start, count=count)


def iter_chunks(
    path: str | Path, sheet: str, header_row: int, *, chunk_size: int = DEFAULT_CHUNK_SIZE
) -> Iterator[ParsedSheet]:
    """Stream `sheet` from `path` in batches of at most `chunk_size` data rows.

    Row `header_row` (1-indexed) supplies the headers; rows above it are metadata
    and skipped; empty rows below it are dropped. Each yielded `ParsedSheet` shares
    the same `headers` and carries one batch as its `df` — the full row set is never
    held in memory at once. Always yields at least one chunk (an empty `df` when the
    sheet has headers but no data rows) so callers can rely on the column layout.

    NOTE: this is a generator — argument/structural validation happens lazily on the
    first `next()`, matching how the worker consumes it. The active backend is also
    resolved lazily inside the generator body, at that same first `next()`.
    """
    yield from _backend().iter_chunks(path, sheet, header_row, chunk_size=chunk_size)


def parse(path: str | Path, sheet: str, header_row: int) -> ParsedSheet:
    """Read `sheet` from `path` as a single DataFrame, using row `header_row`
    (1-indexed) as headers.

    Convenience wrapper over `iter_chunks` for small sources (e.g. lookup tables);
    concatenates all chunks. For large inputs prefer `iter_chunks` to keep memory
    bounded. Rows above `header_row` are treated as metadata and skipped.
    """
    chunks = list(iter_chunks(path, sheet, header_row, chunk_size=DEFAULT_CHUNK_SIZE))
    if len(chunks) == 1:
        return chunks[0]
    headers = chunks[0].headers
    df = pd.concat([c.df for c in chunks], ignore_index=True)
    return ParsedSheet(headers=headers, df=df)


def _make_sheet(headers: list[str], data_rows: list[list[object]]) -> ParsedSheet:
    """Pad/trim each row to the header width and build a DataFrame for one chunk.

    Shared by both backends — backend-agnostic, so it lives here rather than
    being duplicated in each `_reader_*` module.
    """
    width = len(headers)
    normalized = [list(row[:width]) + [None] * max(0, width - len(row)) for row in data_rows]
    return ParsedSheet(headers=headers, df=pd.DataFrame(normalized, columns=headers))


def _normalize_header(cell: object) -> str:
    if cell is None:
        return ""
    return str(cell).strip()


def _row_is_empty(row: tuple) -> bool:
    return all(cell is None or (isinstance(cell, str) and cell.strip() == "") for cell in row)
