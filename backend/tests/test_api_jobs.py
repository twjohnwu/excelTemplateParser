"""End-to-end-ish tests for the jobs API: multipart create + validation."""

from __future__ import annotations

import json

import pytest

CONFIG = {
    "name": "demo",
    "target_template": {
        "sheet": "Sheet1",
        "header_row": 1,
        "columns": ["訂單編號", "客戶名稱"],
    },
    "sources": [
        {"alias": "orders", "role": "primary", "sheet": "訂單", "header_row": 1},
        {"alias": "customers", "role": "lookup", "sheet": "客戶", "header_row": 1},
    ],
    "joins": [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "left"},
    ],
    "mappings": [
        {"target": "訂單編號", "source": "orders.單號"},
        {"target": "客戶名稱", "source": "customers.名稱"},
    ],
}


def _save_config(api_client, cfg=CONFIG):
    return api_client.post("/api/configs", json=cfg)


def _multipart(target, primaries, lookups):
    """Build a multipart files tuple list for httpx/requests TestClient."""
    out = [("target_template", ("target.xlsx", open(target, "rb"), "application/octet-stream"))]
    for name, path in primaries:
        out.append(("sources[orders]", (name, open(path, "rb"), "application/octet-stream")))
    for alias, path in lookups:
        out.append((f"sources[{alias}]", (f"{alias}.xlsx", open(path, "rb"), "application/octet-stream")))
    return out


def test_create_job_happy_path(api_client, target_xlsx, orders_xlsx, customers_xlsx):
    _save_config(api_client)
    files = _multipart(
        target_xlsx,
        [("orders_may.xlsx", orders_xlsx)],
        [("customers", customers_xlsx)],
    )
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]

    state = api_client.get(f"/api/jobs/{job_id}/state").json()
    assert state["status"] == "pending"
    assert "orders_may.xlsx" in state["subtasks"]

    # Files landed.
    job_dir = api_client.data_dir / "jobs" / job_id
    assert (job_dir / "uploads" / "target.xlsx").exists()
    assert (job_dir / "uploads" / "primary" / "orders_may.xlsx").exists()
    assert (job_dir / "uploads" / "lookup" / "customers.xlsx").exists()

    # Subtask + finalize enqueued.
    fns = [q[0] for q in api_client.recorded_queue.enqueued]
    assert "app.workers.tasks.run_subtask" in fns
    assert "app.workers.tasks.finalize_job" in fns


def test_create_job_zero_primary_returns_422(api_client, target_xlsx, customers_xlsx):
    _save_config(api_client)
    files = _multipart(target_xlsx, [], [("customers", customers_xlsx)])
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    assert r.status_code == 422
    assert "primary" in r.json()["detail"]


def test_create_job_two_lookup_returns_422(api_client, target_xlsx, orders_xlsx, customers_xlsx):
    _save_config(api_client)
    files = _multipart(
        target_xlsx,
        [("orders.xlsx", orders_xlsx)],
        [("customers", customers_xlsx), ("customers", customers_xlsx)],
    )
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    assert r.status_code == 422
    assert "lookup" in r.json()["detail"]


def test_create_job_duplicate_primary_returns_422(api_client, target_xlsx, orders_xlsx, customers_xlsx):
    _save_config(api_client)
    files = _multipart(
        target_xlsx,
        [("orders.xlsx", orders_xlsx), ("orders.xlsx", orders_xlsx)],
        [("customers", customers_xlsx)],
    )
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    assert r.status_code == 422
    assert "同名" in r.json()["detail"]


def test_create_job_unknown_config_returns_404(api_client, target_xlsx, orders_xlsx):
    files = _multipart(target_xlsx, [("orders.xlsx", orders_xlsx)], [])
    r = api_client.post("/api/jobs", data={"config_name": "missing"}, files=files)
    assert r.status_code == 404


def test_create_job_preflight_catches_missing_column(api_client, target_xlsx, make_xlsx, customers_xlsx):
    _save_config(api_client)
    # orders xlsx without 客戶代號 column.
    broken = make_xlsx({
        "訂單": [["單號", "狀態", "總額"], ["A001", "成立", 100]],
    }, filename="broken_orders.xlsx")
    files = _multipart(
        target_xlsx,
        [("broken_orders.xlsx", broken)],
        [("customers", customers_xlsx)],
    )
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "客戶代號" in detail["error"]
    assert detail["code"] == "TemplateInvalid"


def test_create_job_non_xlsx_returns_422(api_client, orders_xlsx, customers_xlsx, tmp_path):
    _save_config(api_client)
    bad_target = tmp_path / "not_xlsx.xlsx"
    bad_target.write_bytes(b"plain text")
    files = _multipart(bad_target, [("orders.xlsx", orders_xlsx)], [("customers", customers_xlsx)])
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "TemplateInvalid"


def test_create_job_via_inline_config(api_client, target_xlsx, orders_xlsx, customers_xlsx, tmp_path):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(CONFIG), encoding="utf-8")
    files = _multipart(
        target_xlsx,
        [("orders.xlsx", orders_xlsx)],
        [("customers", customers_xlsx)],
    )
    files.append(("config_json", ("config.json", open(cfg_path, "rb"), "application/json")))
    r = api_client.post("/api/jobs", files=files)
    assert r.status_code == 200


def test_get_job_404(api_client):
    r = api_client.get("/api/jobs/nonexistent")
    assert r.status_code == 404


def test_batch_snapshot(api_client, target_xlsx, orders_xlsx, customers_xlsx):
    _save_config(api_client)
    files = _multipart(target_xlsx, [("orders.xlsx", orders_xlsx)], [("customers", customers_xlsx)])
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    job_id = r.json()["job_id"]

    r = api_client.get(f"/api/jobs?ids={job_id},missing")
    assert r.status_code == 200
    snaps = r.json()["snapshots"]
    assert snaps[0]["job_id"] == job_id
    assert snaps[1]["status"] == "missing"


def test_cancel_pending_job(api_client, target_xlsx, orders_xlsx, customers_xlsx):
    _save_config(api_client)
    files = _multipart(target_xlsx, [("orders.xlsx", orders_xlsx)], [("customers", customers_xlsx)])
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    job_id = r.json()["job_id"]

    r = api_client.post(f"/api/jobs/{job_id}/cancel")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"

    # Artifacts swept.
    assert not (api_client.data_dir / "jobs" / job_id).exists()


def test_download_404_before_zip_ready(api_client, target_xlsx, orders_xlsx, customers_xlsx):
    _save_config(api_client)
    files = _multipart(target_xlsx, [("orders.xlsx", orders_xlsx)], [("customers", customers_xlsx)])
    r = api_client.post("/api/jobs", data={"config_name": "demo"}, files=files)
    job_id = r.json()["job_id"]

    r = api_client.get(f"/api/jobs/{job_id}/zip")
    assert r.status_code == 404  # zip not generated yet
