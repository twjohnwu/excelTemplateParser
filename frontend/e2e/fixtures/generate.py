"""Regenerate the e2e xlsx fixtures.

Run with the backend venv: `backend/.venv/bin/python frontend/e2e/fixtures/generate.py`
Mirrors the fixture shapes `scripts/smoke_test.py` uses for the API smoke run.
"""

from __future__ import annotations

import io
from pathlib import Path

from openpyxl import Workbook

OUT = Path(__file__).parent


def make_xlsx(path: Path, sheets: dict[str, list[list]]) -> None:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(title=name)
        for row in rows:
            ws.append(row)
    wb.save(path)


def main() -> None:
    # Target template: header on row 1, Sheet1.
    make_xlsx(OUT / "target.xlsx", {
        "Sheet1": [
            ["訂單編號", "客戶名稱", "金額"],
        ]
    })

    # Multi-sheet source with header on row 3 (rows 1-2 are a title/blank
    # banner) — exercises the SheetHeaderPicker row-click flow (§8.15).
    make_xlsx(OUT / "orders_header_row3.xlsx", {
        "訂單": [
            ["匯出報表"],
            [],
            ["單號", "客戶代號", "金額"],
            ["A001", "C1", 1000],
            ["A002", "C2", 500],
        ],
        "備註": [
            ["說明"],
            ["這是備註頁"],
        ],
    })

    # Twelve tiny valid primary source files (header on row 1). §8.19 (ETA)
    # needs a job whose total exceeds ETA_MIN_SAMPLES=5 so eta_seconds can be
    # observed while the job is still running (not yet "done") after the 5th
    # subtask completes; §8.20 (partial failure) uses 4 of these + 1 corrupt.
    for i in range(1, 13):
        make_xlsx(OUT / f"primary_{i}.xlsx", {
            "訂單": [
                ["單號", "客戶代號", "金額"],
                [f"A{i:03d}", "C1", 100 * i],
            ]
        })

    # Corrupt "xlsx": not a zip archive at all. Uploading this as a primary
    # rejects the WHOLE batch at creation time (api/jobs.py's magic-byte /
    # preflight checks run over every primary before any subtask is created)
    # — used in partial-failure.spec.ts to prove that boundary, not to
    # produce a partial ZIP.
    (OUT / "corrupt.xlsx").write_bytes(b"not a real xlsx file")

    # Structurally valid but bad DATA: same header as primary_N.xlsx, but
    # 金額 holds text instead of a number. This passes preflight (only header
    # *names* are checked, backend/app/core/preflight.py:64-73) and only
    # fails inside the worker's per-file mapping step, when the ">=" numeric
    # condition on 金額 can't coerce it (backend/app/core/mapper.py "_numeric"
    # raises MappingError). That gives one failed subtask alongside otherwise
    # successful ones — the actual "partial failure" shape §8.20 describes,
    # which a truly-corrupt/missing-column file cannot produce (those reject
    # the whole batch up front instead of failing one subtask).
    make_xlsx(OUT / "primary_bad_amount.xlsx", {
        "訂單": [
            ["單號", "客戶代號", "金額"],
            ["A099", "C1", "非數字"],
        ]
    })


if __name__ == "__main__":
    main()
    print("wrote fixtures to", OUT)
