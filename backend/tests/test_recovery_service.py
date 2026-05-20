import pytest

from app.schemas import ConfigSchema
from app.services.job_service import JobService
from app.services.recovery_service import scan_and_resume


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


def test_resume_reenqueues_pending(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx", "b.xlsx"])
    enqueued: list[tuple[str, str]] = []

    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
    )
    assert n == 2
    assert ("j", "a.xlsx") in enqueued
    assert ("j", "b.xlsx") in enqueued


def test_resume_skips_existing_outputs(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx", "b.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    out_dir.mkdir(parents=True)
    (out_dir / "a.xlsx.out.xlsx").write_bytes(b"already done")

    enqueued: list[tuple[str, str]] = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
    )
    assert n == 1
    assert ("j", "b.xlsx") in enqueued
    assert ("j", "a.xlsx") not in enqueued


def test_resume_skips_terminal_jobs(jobs, tmp_path):
    jobs.create("done", _config(), ["a.xlsx"])
    jobs.mark_done("done", "a.xlsx", duration_ms=100)
    jobs.create("cancelled", _config(), ["b.xlsx"])
    jobs.mark_cancelled("cancelled")

    enqueued = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
    )
    assert n == 0
    assert enqueued == []


def test_resume_rehydrates_redis_from_disk(jobs, tmp_path, redis_client):
    jobs.create("j", _config(), ["a.xlsx"])
    # Simulate Redis volume loss.
    redis_client.flushall()
    scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
    )
    assert redis_client.get("job:j") is not None


def test_resume_empty_dir_returns_zero(jobs, tmp_path):
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs_does_not_exist",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
    )
    assert n == 0
