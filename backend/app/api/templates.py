"""POST /api/templates/parse — upload xlsx, return sheets + preview rows."""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Query, UploadFile

from ..core import parser

router = APIRouter(prefix="/api/templates", tags=["templates"])

PREVIEW_ROW_COUNT = 30


@router.post("/parse")
async def parse_template(
    file: UploadFile = File(...),
    from_row: int = Query(default=1, ge=1),
):
    """Return all sheets and a window of preview rows starting at `from_row`.

    Used by the SheetHeaderPicker UI: the user uploads a workbook, picks a
    sheet, then clicks any row in the preview to set it as `header_row`.
    """
    contents = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp.write(contents)
        tmp_path = Path(tmp.name)

    try:
        sheets = []
        for name in parser.list_sheets(tmp_path):
            preview = parser.preview_rows(
                tmp_path, name, start=from_row, count=PREVIEW_ROW_COUNT
            )
            sheets.append({"name": name, "preview_rows": preview, "preview_starts_at": from_row})
        return {"filename": file.filename, "sheets": sheets}
    finally:
        tmp_path.unlink(missing_ok=True)
