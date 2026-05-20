"""Excel parsing: workbook → DataFrame + header info.

Uses openpyxl read_only mode for streaming reads to keep memory bounded.
Raises TemplateInvalid for any structural problem (corrupt file, missing
sheet, header row out of range).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd
from zipfile import BadZipFile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from .exceptions import TemplateInvalid


@dataclass(frozen=True)
class ParsedSheet:
    """Result of parsing one sheet of a workbook."""

    headers: list[str]
    df: pd.DataFrame


def list_sheets(path: str | Path) -> list[str]:
    """Return sheet names in the workbook (cheap; no row scan)."""
    try:
        wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    except (InvalidFileException, FileNotFoundError, OSError, KeyError, BadZipFile) as exc:
        raise TemplateInvalid(
            user_message="範本檔損毀或非 xlsx 格式",
            tech_detail=f"{type(exc).__name__}: {exc}",
            path=str(path),
        ) from exc
    try:
        return list(wb.sheetnames)
    finally:
        wb.close()


def preview_rows(path: str | Path, sheet: str, *, start: int = 1, count: int = 30) -> list[list[object]]:
    """Return the first `count` rows of `sheet` starting from `start` (1-indexed).

    Used by the templates parse endpoint to power the sheet/header_row picker.
    """
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
        out: list[list[object]] = []
        for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if i < start:
                continue
            out.append(list(row))
            if len(out) >= count:
                break
        return out
    finally:
        wb.close()


def parse(path: str | Path, sheet: str, header_row: int) -> ParsedSheet:
    """Read `sheet` from `path` as a DataFrame, using row `header_row` (1-indexed) as headers.

    Rows above `header_row` are treated as metadata and skipped. The DataFrame
    contains all rows below the header.
    """
    if header_row < 1:
        raise TemplateInvalid(
            user_message="標頭列號必須 ≥ 1",
            tech_detail=f"header_row={header_row}",
        )

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
        data_rows: list[list[object]] = []
        for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if i < header_row:
                continue
            if i == header_row:
                headers = [_normalize_header(cell) for cell in row]
                continue
            if not _row_is_empty(row):
                data_rows.append(list(row))

        if headers is None:
            raise TemplateInvalid(
                user_message=f"工作表「{sheet}」沒有第 {header_row} 列",
                tech_detail="header_row beyond last row in sheet",
                sheet=sheet,
                header_row=header_row,
            )

        # Pad / trim rows to match header width.
        width = len(headers)
        normalized = [list(row[:width]) + [None] * max(0, width - len(row)) for row in data_rows]

        df = pd.DataFrame(normalized, columns=headers)
        return ParsedSheet(headers=headers, df=df)
    finally:
        wb.close()


def _normalize_header(cell: object) -> str:
    if cell is None:
        return ""
    return str(cell).strip()


def _row_is_empty(row: tuple) -> bool:
    return all(cell is None or (isinstance(cell, str) and cell.strip() == "") for cell in row)
