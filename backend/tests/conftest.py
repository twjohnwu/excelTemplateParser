"""Shared pytest fixtures: in-memory xlsx fixtures for core tests + fakeredis."""

from __future__ import annotations

from pathlib import Path

import fakeredis
import pytest
from openpyxl import Workbook


@pytest.fixture
def redis_client():
    """In-memory Redis substitute for service tests."""
    client = fakeredis.FakeRedis()
    yield client
    client.flushall()
    client.close()


@pytest.fixture
def api_client(tmp_path, redis_client, monkeypatch):
    """FastAPI TestClient wired to fakeredis + tmp DATA_DIR + a recording queue.

    The queue records enqueued subtasks instead of actually running them so
    API tests stay synchronous.
    """
    from fastapi.testclient import TestClient
    from app.dependencies import (
        get_cleanup_service,
        get_config_service,
        get_job_service,
        get_queue,
        get_redis,
    )
    from app.main import create_app
    from app.services.cleanup_service import CleanupService
    from app.services.config_service import ConfigService
    from app.services.job_service import JobService

    data_dir = tmp_path / "data"
    monkeypatch.setenv("DATA_DIR", str(data_dir))
    monkeypatch.setenv("REDIS_URL", "redis://localhost:0/0")
    # Force settings re-read so DATA_DIR takes effect.
    from app.settings import get_settings
    get_settings.cache_clear() if hasattr(get_settings, "cache_clear") else None

    app = create_app()

    class _RecordingQueue:
        def __init__(self):
            self.enqueued: list[tuple[str, dict]] = []
            self._default_timeout = 600

        def enqueue(self, func_path, kwargs=None, **_):  # type: ignore[no-untyped-def]
            self.enqueued.append((func_path, kwargs or {}))
            return None

        def get_jobs(self):
            return []

    queue = _RecordingQueue()

    app.dependency_overrides[get_redis] = lambda: redis_client
    app.dependency_overrides[get_queue] = lambda: queue
    app.dependency_overrides[get_config_service] = lambda: ConfigService(
        redis=redis_client, configs_dir=data_dir / "configs"
    )
    app.dependency_overrides[get_job_service] = lambda: JobService(
        redis=redis_client, jobs_dir=data_dir / "jobs"
    )
    app.dependency_overrides[get_cleanup_service] = lambda: CleanupService(
        redis=redis_client, jobs_dir=data_dir / "jobs",
        grace_minutes=60, retention_hours=24,
    )

    # Skip lifespan (recovery/scheduler) for fast unit tests.
    with TestClient(app) as client:
        client.recorded_queue = queue  # type: ignore[attr-defined]
        client.data_dir = data_dir     # type: ignore[attr-defined]
        yield client


@pytest.fixture
def make_xlsx(tmp_path: Path):
    """Factory: build a workbook with one or more sheets and return the path.

    Usage:
        path = make_xlsx({"訂單": [["單號", "客戶代號"], ["A001", "C1"], ["A002", "C2"]]})
    """

    def _make(sheets: dict[str, list[list[object]]], filename: str = "test.xlsx") -> Path:
        wb = Workbook()
        wb.remove(wb.active)  # drop default sheet
        for name, rows in sheets.items():
            ws = wb.create_sheet(title=name)
            for row in rows:
                ws.append(row)
        out = tmp_path / filename
        wb.save(out)
        return out

    return _make


@pytest.fixture
def orders_xlsx(make_xlsx):
    return make_xlsx({
        "訂單": [
            ["單號", "客戶代號", "狀態", "總額"],
            ["A001", "C1", "成立", 1000],
            ["A002", "C2", "取消", 500],
            ["A003", "C1", "成立", 2500],
        ]
    }, filename="orders.xlsx")


@pytest.fixture
def customers_xlsx(make_xlsx):
    return make_xlsx({
        "客戶": [
            ["代號", "名稱", "業務員代號"],
            ["C1", "客戶一", "S1"],
            ["C2", "客戶二", "S2"],
        ]
    }, filename="customers.xlsx")


@pytest.fixture
def sales_xlsx(make_xlsx):
    return make_xlsx({
        "業務員": [
            ["代號", "姓名"],
            ["S1", "張三"],
            ["S2", "李四"],
        ]
    }, filename="sales.xlsx")


@pytest.fixture
def target_xlsx(make_xlsx):
    return make_xlsx({
        "Sheet1": [
            ["訂單編號", "客戶名稱", "業務員", "金額"],
        ]
    }, filename="target.xlsx")
