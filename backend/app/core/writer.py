"""Write a DataFrame to a target template, preserving the template's styling.

Loads the template workbook (not read_only), keeps its column widths,
fonts, merged cells, and formulas intact, and fills rows starting at
header_row + 1.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from zipfile import BadZipFile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from .exceptions import WriterError


def write(target_template: str | Path, df: pd.DataFrame, sheet: str, header_row: int, out_path: str | Path) -> None:
    """Open `target_template`, fill rows starting at `header_row + 1`, save to `out_path`.

    Existing cells from `header_row + 1` downward are overwritten with values
    from `df`; everything else (headers, formatting, merged cells, formulas)
    is left untouched.
    """
    src = Path(target_template)
    dst = Path(out_path)

    try:
        wb = load_workbook(filename=str(src), data_only=False, keep_vba=False)
    except (InvalidFileException, FileNotFoundError, OSError, BadZipFile) as exc:
        raise WriterError(
            user_message="目標範本檔損毀或無法開啟",
            tech_detail=f"{type(exc).__name__}: {exc}",
            path=str(src),
        ) from exc

    try:
        if sheet not in wb.sheetnames:
            raise WriterError(
                user_message=f"目標範本不含工作表「{sheet}」",
                tech_detail=f"available: {wb.sheetnames}",
                sheet=sheet,
            )
        ws = wb[sheet]

        # Map target column names to their column index in the template.
        header_index = {
            _str(ws.cell(row=header_row, column=col_idx).value): col_idx
            for col_idx in range(1, ws.max_column + 1)
        }

        # Mappings whose target isn't a template header are appended as new
        # columns at the right edge (header written at header_row).
        next_col = ws.max_column + 1
        for col_name in df.columns:
            if col_name not in header_index:
                ws.cell(row=header_row, column=next_col, value=col_name)
                header_index[col_name] = next_col
                next_col += 1

        for row_offset, (_, row) in enumerate(df.iterrows(), start=header_row + 1):
            for col_name in df.columns:
                col_idx = header_index[col_name]
                value = row[col_name]
                if pd.isna(value):
                    value = None
                ws.cell(row=row_offset, column=col_idx, value=value)

        dst.parent.mkdir(parents=True, exist_ok=True)
        wb.save(str(dst))
    finally:
        wb.close()


def _str(value: object) -> str:
    return "" if value is None else str(value).strip()
