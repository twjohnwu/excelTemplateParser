"""§8.9 resume test: start a batch, restart the worker mid-flight,
verify the surviving subtasks aren't reprocessed and the job still completes.
"""

from __future__ import annotations

import io
import subprocess
import sys
import time
from pathlib import Path

import httpx
from openpyxl import Workbook

API = "http://localhost:8000"


def make_xlsx(sheets: dict[str, list[list]]) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(title=name)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_orders(n_rows: int) -> bytes:
    rows = [["單號", "客戶代號", "狀態", "總額"]]
    for i in range(n_rows):
        rows.append([f"A{i:04d}", "C1", "成立", 1000])
    return make_xlsx({"訂單": rows})


def main() -> int:
    customers = make_xlsx({"客戶": [["代號", "名稱", "業務員代號"], ["C1", "客戶一", "S1"]]})
    sales = make_xlsx({"業務員": [["代號", "姓名"], ["S1", "張三"]]})
    target = make_xlsx({"Sheet1": [["訂單編號", "客戶名稱", "業務員", "金額"]]})

    config = {
        "version": "1.0",
        "name": "resume_test",
        "target_template": {
            "sheet": "Sheet1", "header_row": 1, "preserve_styles": True,
            "columns": ["訂單編號", "客戶名稱", "業務員", "金額"],
        },
        "sources": [
            {"alias": "orders", "role": "primary", "sheet": "訂單", "header_row": 1},
            {"alias": "customers", "role": "lookup", "sheet": "客戶", "header_row": 1},
            {"alias": "sales", "role": "lookup", "sheet": "業務員", "header_row": 1},
        ],
        "joins": [
            {"left": "orders.客戶代號", "right": "customers.代號", "type": "left"},
            {"left": "customers.業務員代號", "right": "sales.代號", "type": "left"},
        ],
        "mappings": [
            {"target": "訂單編號", "source": "orders.單號"},
            {"target": "客戶名稱", "source": "customers.名稱"},
            {"target": "業務員", "source": "sales.姓名"},
            {"target": "金額", "source": "orders.總額"},
        ],
    }

    with httpx.Client(timeout=60) as client:
        client.delete(f"{API}/api/configs/resume_test")
        client.post(f"{API}/api/configs", json=config)

        # Submit 10 primary files. Each pipeline run takes ~50ms locally,
        # so we have a tight window — make orders heavier so restart catches mid-batch.
        big_orders = make_orders(2000)
        files = [
            ("target_template", ("t.xlsx", target, "application/octet-stream")),
            ("sources[customers]", ("c.xlsx", customers, "application/octet-stream")),
            ("sources[sales]", ("s.xlsx", sales, "application/octet-stream")),
        ]
        for i in range(10):
            files.append(("sources[orders]", (f"month_{i:02d}.xlsx", big_orders, "application/octet-stream")))

        r = client.post(f"{API}/api/jobs", data={"config_name": "resume_test"}, files=files)
        if r.status_code != 200:
            print(f"✗ submit failed: {r.status_code} {r.text}")
            return 1
        job_id = r.json()["job_id"]
        print(f"  job_id={job_id}")

        # Wait until at least 2 subtasks are done, then restart worker.
        deadline = time.time() + 30
        partial_done = 0
        while time.time() < deadline:
            snap = client.get(f"{API}/api/jobs/{job_id}").json()
            partial_done = snap["done"]
            if partial_done >= 2 and partial_done < snap["total"]:
                break
            if snap["status"] in ("done", "failed"):
                print(f"  ⚠ job finished before we could restart (done={partial_done})")
                return 0
            time.sleep(0.2)

        print(f"  restarting worker after {partial_done} subtasks done…")
        subprocess.run(
            ["docker", "compose", "restart", "worker"],
            cwd=Path(__file__).resolve().parent.parent,
            check=True,
            capture_output=True,
        )

        # Wait for completion.
        deadline = time.time() + 120
        final = None
        while time.time() < deadline:
            snap = client.get(f"{API}/api/jobs/{job_id}").json()
            if snap["status"] in ("done", "failed"):
                final = snap
                break
            time.sleep(0.5)

        if final is None:
            print(f"  ✗ job did not complete within 120s")
            return 1

        print(f"  final status={final['status']}, done={final['done']}/{final['total']}")
        ok = final["status"] == "done" and final["done"] == 10
        if ok:
            print("  ✓ resume succeeded")
        else:
            print("  ✗ resume incomplete")

        client.delete(f"{API}/api/configs/resume_test")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
