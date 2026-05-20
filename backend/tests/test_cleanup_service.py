from datetime import UTC, datetime, timedelta

import pytest

from app.schemas import ConfigSchema
from app.services.cleanup_service import CleanupService
from app.services.job_service import JobService


def _config() -> ConfigSchema:
    return ConfigSchema.model_validate({
        "name": "demo",
        "target_template": {"sheet": "S", "header_row": 1, "columns": ["a"]},
        "sources": [{"alias": "x", "role": "primary", "sheet": "S", "header_row": 1}],
        "joins": [],
        "mappings": [{"target": "a", "source": "x.a"}],
    })


@pytest.fixture
def jobs(redis_client, tmp_path):
    return JobService(redis=redis_client, jobs_dir=tmp_path / "jobs")


@pytest.fixture
def cleanup(redis_client, tmp_path):
    return CleanupService(
        redis=redis_client,
        jobs_dir=tmp_path / "jobs",
        grace_minutes=60,
        retention_hours=24,
    )


def test_delete_job_removes_disk_and_redis(jobs, cleanup, redis_client, tmp_path):
    jobs.create("j", _config(), ["a.xlsx"])
    redis_client.sadd("job:j:done", "a.xlsx")
    assert cleanup.delete_job("j") is True
    assert not (tmp_path / "jobs" / "j").exists()
    assert not redis_client.exists("job:j")
    assert not redis_client.exists("job:j:done")


def test_delete_nonexistent_returns_false(cleanup):
    assert cleanup.delete_job("never") is False


def test_grace_expired_deletes_old_downloaded(jobs, cleanup, tmp_path):
    jobs.create("old", _config(), ["a.xlsx"])
    # Backdate download_started_at by 2 hours.
    state = jobs.get_state("old")
    state.download_started_at = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    (tmp_path / "jobs" / "old" / "state.json").write_text(
        state.model_dump_json(indent=2), encoding="utf-8"
    )

    deleted = cleanup.purge_grace_expired()
    assert deleted == 1
    assert not (tmp_path / "jobs" / "old").exists()


def test_grace_expired_skips_fresh_download(jobs, cleanup):
    jobs.create("fresh", _config(), ["a.xlsx"])
    jobs.mark_download_started("fresh")
    assert cleanup.purge_grace_expired() == 0


def test_grace_expired_skips_undownloaded(jobs, cleanup):
    jobs.create("undownloaded", _config(), ["a.xlsx"])
    assert cleanup.purge_grace_expired() == 0


def test_purge_old_jobs(jobs, cleanup, tmp_path):
    jobs.create("old", _config(), ["a.xlsx"])
    jobs.create("new", _config(), ["b.xlsx"])
    # Backdate 'old' by 48 hours.
    state = jobs.get_state("old")
    state.created_at = (datetime.now(UTC) - timedelta(hours=48)).isoformat()
    (tmp_path / "jobs" / "old" / "state.json").write_text(
        state.model_dump_json(indent=2), encoding="utf-8"
    )

    assert cleanup.purge_old_jobs() == 1
    assert not (tmp_path / "jobs" / "old").exists()
    assert (tmp_path / "jobs" / "new").exists()


def test_purge_old_jobs_custom_threshold(jobs, cleanup):
    jobs.create("any", _config(), ["a.xlsx"])
    # Threshold 0 hours: everything is "old".
    assert cleanup.purge_old_jobs(older_than_hours=0) == 1
