from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from app.schemas import ConfigSchema
from app.services.job_service import JobNotFound, JobService


def _config() -> ConfigSchema:
    return ConfigSchema.model_validate({
        "name": "demo",
        "target_template": {"sheet": "S", "header_row": 1, "columns": ["a"]},
        "sources": [{"alias": "x", "role": "primary", "sheet": "S", "header_row": 1}],
        "joins": [],
        "mappings": [{"target": "a", "source": "x.a"}],
    })


@pytest.fixture
def svc(redis_client, tmp_path):
    return JobService(redis=redis_client, jobs_dir=tmp_path / "jobs")


def test_create_writes_state_and_redis(svc, tmp_path, redis_client):
    state = svc.create("job1", _config(), ["a.xlsx", "b.xlsx"])
    assert state.total == 2
    assert state.status == "pending"
    assert (tmp_path / "jobs" / "job1" / "state.json").exists()
    assert redis_client.get("job:job1") is not None


def test_mark_done_updates_status(svc):
    svc.create("j", _config(), ["a.xlsx"])
    svc.mark_running("j", "a.xlsx")
    svc.mark_done("j", "a.xlsx", duration_ms=1234)
    snap = svc.get_snapshot("j")
    assert snap.status == "done"
    assert snap.done == 1
    assert snap.failed == 0


def test_mark_failed_marks_job_failed_when_terminal(svc):
    svc.create("j", _config(), ["a.xlsx"])
    svc.mark_failed("j", "a.xlsx", "broken", "stack")
    state = svc.get_state("j")
    assert state.status == "failed"
    assert state.subtasks["a.xlsx"].user_message == "broken"


def test_partial_failure(svc):
    svc.create("j", _config(), ["a.xlsx", "b.xlsx"])
    svc.mark_done("j", "a.xlsx", 100)
    svc.mark_failed("j", "b.xlsx", "bad")
    state = svc.get_state("j")
    assert state.status == "failed"  # any failure marks job failed
    assert state.done == 1
    assert state.failed == 1


def test_cancel_flag(svc):
    svc.create("j", _config(), ["a.xlsx"])
    assert not svc.is_cancel_requested("j")
    svc.mark_cancelled("j")
    assert svc.is_cancel_requested("j")
    assert svc.get_state("j").status == "cancelled"


def test_eta_below_threshold_returns_none(svc):
    svc.create("j", _config(), [f"f{i}.xlsx" for i in range(10)])
    for i in range(3):  # below ETA_MIN_SAMPLES=5
        svc.mark_done("j", f"f{i}.xlsx", 1000)
    assert svc.get_snapshot("j").eta_seconds is None


def test_eta_computed_after_threshold(svc):
    svc.create("j", _config(), [f"f{i}.xlsx" for i in range(10)])
    for i in range(5):
        svc.mark_done("j", f"f{i}.xlsx", 2000)  # 2s each
    snap = svc.get_snapshot("j")
    # avg 2s × 5 remaining = 10s
    assert snap.eta_seconds == 10


def test_download_expires_at_absent_before_first_download(svc):
    svc.create("j", _config(), ["a.xlsx"])
    snap = svc.get_snapshot("j")
    assert snap.download_expires_at is None


def test_download_expires_at_present_after_mark_download_started(svc, monkeypatch):
    frozen = datetime(2025, 1, 1, 12, 0, 0, tzinfo=UTC)

    svc.create("j", _config(), ["a.xlsx"])

    # Patch datetime.now inside job_service so mark_download_started uses the frozen time.
    with patch("app.services.job_service.datetime") as mock_dt:
        mock_dt.now.return_value = frozen
        mock_dt.fromisoformat = datetime.fromisoformat
        svc.mark_download_started("j")

    # Patch get_settings to return a fixed grace of 60 minutes.
    from app.settings import Settings
    fake_settings = Settings.model_construct(download_grace_minutes=60)
    with patch("app.services.job_service.get_settings", return_value=fake_settings):
        snap = svc.get_snapshot("j")

    expected = (frozen + timedelta(minutes=60)).isoformat()
    assert snap.download_expires_at == expected


def test_get_snapshot_missing(svc):
    with pytest.raises(JobNotFound):
        svc.get_snapshot("missing")


def test_mark_download_started_only_once(svc):
    svc.create("j", _config(), ["a.xlsx"])
    svc.mark_download_started("j")
    first = svc.get_state("j").download_started_at
    svc.mark_download_started("j")
    second = svc.get_state("j").download_started_at
    assert first == second


def test_list_active_ids(svc):
    svc.create("a", _config(), ["x.xlsx"])
    svc.create("b", _config(), ["y.xlsx"])
    svc.mark_done("b", "y.xlsx", 100)  # b becomes done
    assert svc.list_active_ids() == ["a"]
