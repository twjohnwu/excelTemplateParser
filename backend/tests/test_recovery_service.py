import os
import time

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


def _age_file(path, seconds_old: float) -> None:
    old = time.time() - seconds_old
    os.utime(path, (old, old))


def test_resume_sweeps_stale_tmp_and_reenqueues(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    out_dir.mkdir(parents=True)
    stale_tmp = out_dir / ".tmp-123-abcd1234"
    stale_tmp.write_bytes(b"leftover from a killed write")
    _age_file(stale_tmp, seconds_old=7200)  # 2h old — clearly stale

    enqueued: list[tuple[str, str]] = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
        stale_tmp_seconds=660,
    )

    assert not stale_tmp.exists()
    assert n == 1
    assert ("j", "a.xlsx") in enqueued


def test_resume_sweeps_stale_tmp_for_terminal_job(jobs, tmp_path):
    jobs.create("done", _config(), ["a.xlsx"])
    jobs.mark_done("done", "a.xlsx", duration_ms=100)
    out_dir = tmp_path / "jobs" / "done" / "out"
    out_dir.mkdir(parents=True)
    stale_tmp = out_dir / ".tmp-999-deadbeef"
    stale_tmp.write_bytes(b"leftover from a crash on the last subtask")
    _age_file(stale_tmp, seconds_old=7200)

    enqueued: list[tuple[str, str]] = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
        stale_tmp_seconds=660,
    )

    assert not stale_tmp.exists()
    assert n == 0
    assert enqueued == []


def test_resume_leaves_young_tmp_file_in_place(jobs, tmp_path):
    """A `.tmp-*` written moments ago may belong to a worker still writing
    it — deleting it out from under that writer surfaces as
    `atomic_path: writer produced no file` (this was the crash-drill bug)."""
    jobs.create("j", _config(), ["a.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    out_dir.mkdir(parents=True)
    young_tmp = out_dir / ".tmp-123-freshfile"
    young_tmp.write_bytes(b"a worker is still writing this")
    # mtime left at "now" (default os.utime on write) — well under the
    # stale threshold.

    scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
        stale_tmp_seconds=660,
    )

    assert young_tmp.exists()


def test_resume_enqueue_failure_on_one_subtask_does_not_block_others(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx", "b.xlsx"])
    enqueued: list[str] = []

    def _flaky_enqueue(job_id, source_file):
        if source_file == "a.xlsx":
            raise RuntimeError("redis connection reset")
        enqueued.append(source_file)

    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=_flaky_enqueue,
    )

    assert enqueued == ["b.xlsx"]
    assert n == 1


def test_resume_reenqueues_finalize_when_all_terminal_and_zip_missing(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx"])
    jobs.mark_done("j", "a.xlsx", duration_ms=100)  # job now "done", no zip on disk

    finalized: list[str] = []
    scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
        enqueue_finalize=lambda jid: finalized.append(jid),
    )

    assert finalized == ["j"]


def test_resume_does_not_reenqueue_finalize_when_zip_present(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx"])
    jobs.mark_done("j", "a.xlsx", duration_ms=100)
    (tmp_path / "jobs" / "j" / "result.zip").write_bytes(b"already packed")

    finalized: list[str] = []
    scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
        enqueue_finalize=lambda jid: finalized.append(jid),
    )

    assert finalized == []


def test_resume_does_not_reenqueue_finalize_for_cancelled_job(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx"])
    jobs.mark_cancelled("j")

    finalized: list[str] = []
    scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
        enqueue_finalize=lambda jid: finalized.append(jid),
    )

    assert finalized == []


def test_resume_empty_dir_returns_zero(jobs, tmp_path):
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs_does_not_exist",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
    )
    assert n == 0
