"""Registration tests for `app/services/scheduler.py`.

Doesn't run the jobs (that's cleanup_service's / recovery_service's own
tests); just checks the APScheduler wiring matches what the lifespan needs.
"""

from __future__ import annotations

from app.services.cleanup_service import CleanupService
from app.services.scheduler import build_scheduler


def _cleanup(redis_client, tmp_path) -> CleanupService:
    return CleanupService(redis=redis_client, jobs_dir=tmp_path / "jobs")


def test_build_scheduler_registers_cleanup_jobs(redis_client, tmp_path):
    scheduler = build_scheduler(_cleanup(redis_client, tmp_path))
    ids = {job.id for job in scheduler.get_jobs()}
    assert {"purge_grace_expired", "purge_old_jobs"} <= ids
    assert "resume_scan" not in ids


def test_build_scheduler_registers_resume_job_with_configured_interval(redis_client, tmp_path):
    scheduler = build_scheduler(
        _cleanup(redis_client, tmp_path),
        resume=lambda: None,
        resume_scan_seconds=45,
    )
    resume_job = scheduler.get_job("resume_scan")
    assert resume_job is not None
    assert resume_job.trigger.interval.total_seconds() == 45
