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


def _make_valid_xlsx(path):
    """Write a minimal but genuinely valid xlsx (a real zip)."""
    from openpyxl import Workbook

    path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    wb.save(path)


def test_resume_skips_existing_outputs(jobs, tmp_path):
    """Output exists AND the subtask is already marked done — nothing to
    reconcile or re-enqueue. (The "output exists but subtask still pending"
    case is covered separately below — that one gets reconciled, not
    skipped: see test_resume_reconciles_output_written_before_crash.)"""
    jobs.create("j", _config(), ["a.xlsx", "b.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    _make_valid_xlsx(out_dir / "a.xlsx.out.xlsx")
    jobs.mark_done("j", "a.xlsx", duration_ms=10)

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


def test_resume_reconciles_output_written_before_crash(jobs, tmp_path):
    """Worker killed between os.replace and mark_done: output exists but the
    subtask is still pending. Recovery must reconcile it (mark_done +
    finalize), not re-enqueue it and not leave the job stuck forever."""
    jobs.create("j", _config(), ["a.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    _make_valid_xlsx(out_dir / "a.xlsx.out.xlsx")

    enqueued: list[tuple[str, str]] = []
    finalized: list[str] = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
        enqueue_finalize=lambda jid: finalized.append(jid),
    )

    assert enqueued == []
    assert n == 0
    state = jobs.get_state("j")
    assert state.subtasks["a.xlsx"].status == "done"
    assert state.subtasks["a.xlsx"].duration_ms is None
    assert state.status == "done"
    assert finalized == ["j"]


def test_resume_removes_corrupt_output_and_reenqueues(jobs, tmp_path):
    """Output exists but is garbage (truncated/corrupt write) — recovery must
    not trust it as done; it removes the file and re-enqueues the subtask."""
    jobs.create("j", _config(), ["a.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    out_dir.mkdir(parents=True)
    garbage = out_dir / "a.xlsx.out.xlsx"
    garbage.write_bytes(b"not a real zip file at all")

    enqueued: list[tuple[str, str]] = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
    )

    assert not garbage.exists()
    assert enqueued == [("j", "a.xlsx")]
    assert n == 1
    state = jobs.get_state("j")
    assert state.subtasks["a.xlsx"].status == "pending"


def test_resume_output_exists_but_subtask_already_done_is_noop(jobs, tmp_path):
    """Output exists AND the subtask is already marked done (the normal,
    already-reconciled case) — recovery must not re-mark_done or finalize
    again. Uses a 2-subtask job so the job itself stays non-terminal and the
    per-subtask `sub.status in ("done", "failed")` skip is what's exercised
    (not the outer is_terminal guard)."""
    jobs.create("j", _config(), ["a.xlsx", "b.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    _make_valid_xlsx(out_dir / "a.xlsx.out.xlsx")
    jobs.mark_done("j", "a.xlsx", duration_ms=50)

    enqueued: list[tuple[str, str]] = []
    finalized: list[str] = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
        enqueue_finalize=lambda jid: finalized.append(jid),
    )

    assert enqueued == [("j", "b.xlsx")]
    assert finalized == []
    assert n == 1
    state = jobs.get_state("j")
    assert state.subtasks["a.xlsx"].status == "done"
    assert state.subtasks["a.xlsx"].duration_ms == 50  # untouched by reconciliation


def test_resume_reconciles_only_the_pending_output_in_multi_subtask_job(jobs, tmp_path):
    jobs.create("j", _config(), ["a.xlsx", "b.xlsx"])
    out_dir = tmp_path / "jobs" / "j" / "out"
    _make_valid_xlsx(out_dir / "a.xlsx.out.xlsx")  # a: output written, mark_done never ran

    enqueued: list[tuple[str, str]] = []
    finalized: list[str] = []
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: enqueued.append((jid, src)),
        enqueue_finalize=lambda jid: finalized.append(jid),
    )

    assert enqueued == [("j", "b.xlsx")]
    assert n == 1
    state = jobs.get_state("j")
    assert state.subtasks["a.xlsx"].status == "done"
    assert state.subtasks["b.xlsx"].status == "pending"
    assert finalized == []  # b.xlsx still outstanding — no finalize yet


def test_resume_empty_dir_returns_zero(jobs, tmp_path):
    n = scan_and_resume(
        jobs_dir=tmp_path / "jobs_does_not_exist",
        job_service=jobs,
        enqueue_subtask=lambda jid, src: None,
    )
    assert n == 0
