"""Startup recovery: scan /data/jobs/* and re-enqueue subtasks for unfinished jobs.

Runs in the API lifespan (and again at worker start). Idempotent: if a
subtask's output xlsx already exists, the worker will skip it.
"""

from __future__ import annotations

import time
import zipfile
from pathlib import Path

import structlog

from .job_service import JobService
from ..schemas import JobState

log = structlog.get_logger(__name__)

# Fallback used only when a caller doesn't pass an explicit value. Callers
# should wire this from settings (`job_timeout_min * 60 + 60`) so it tracks
# the actual subtask timeout; this default matches settings.job_timeout_min's
# own default (10 min).
DEFAULT_STALE_TMP_SECONDS = 10 * 60 + 60


def scan_and_resume(
    jobs_dir: Path,
    job_service: JobService,
    enqueue_subtask,  # callable(job_id, source_file) -> None
    *,
    stale_tmp_seconds: float = DEFAULT_STALE_TMP_SECONDS,
    enqueue_finalize=None,  # callable(job_id) -> None, optional finalize backstop
) -> int:
    """Re-enqueue every pending/running subtask for non-terminal jobs.

    Returns the number of subtasks re-enqueued.
    """
    if not jobs_dir.exists():
        return 0

    count = 0
    enqueue_failed = 0
    finalize_reenqueued = 0
    reconciled = 0
    now = time.time()
    for child in sorted(jobs_dir.iterdir()):
        state_file = child / "state.json"
        if not state_file.exists():
            continue
        try:
            state = JobState.model_validate_json(state_file.read_text("utf-8"))
        except Exception:
            log.warning("recovery.bad_state_json", path=str(state_file))
            continue

        # Crash-safe cleanup: a kill -9 mid-write can leave a `.tmp-*` sibling
        # from atomic_io behind (the destination itself is always intact —
        # os.replace never ran). Sweep them regardless of the job's status —
        # a crash can land mid-write on the LAST subtask, leaving a terminal
        # job (done/failed/cancelled) with a leftover tmp file too. Only
        # files older than `stale_tmp_seconds` are removed: a young `.tmp-*`
        # may belong to a worker that is still actively writing it, and
        # deleting it out from under that writer surfaces as
        # `atomic_path: writer produced no file`.
        removed = 0
        skipped_young = 0
        for tmp_file in child.rglob(".tmp-*"):
            try:
                age = now - tmp_file.stat().st_mtime
            except FileNotFoundError:
                continue
            if age < stale_tmp_seconds:
                skipped_young += 1
                continue
            tmp_file.unlink(missing_ok=True)
            removed += 1
        if removed:
            log.info("recovery.stale_tmp_removed", job_id=state.job_id, count=removed)
        if skipped_young:
            log.info("recovery.stale_tmp_skipped_young", job_id=state.job_id, count=skipped_young)

        is_cancelled = state.status == "cancelled"
        is_terminal = state.status in ("done", "failed", "cancelled")

        if not is_terminal:
            out_dir = child / "out"
            for source_file, sub in state.subtasks.items():
                out_path = out_dir / f"{source_file}.out.xlsx"
                if out_path.exists():
                    # Already reflected in state.json (normal idempotency) —
                    # nothing to reconcile.
                    if sub.status in ("done", "failed"):
                        continue
                    # A worker can be killed between the output's os.replace
                    # and mark_done: the file is on disk but the subtask is
                    # still pending/running, so it (and the job) would
                    # otherwise sit forever with nothing left to re-enqueue.
                    # Validate the file before trusting it as "done".
                    try:
                        if zipfile.is_zipfile(out_path):
                            with zipfile.ZipFile(out_path) as zf:
                                valid = zf.testzip() is None
                        else:
                            valid = False
                    except (zipfile.BadZipFile, OSError):
                        valid = False
                    if valid:
                        is_last = job_service.mark_done(state.job_id, source_file, duration_ms=None)
                        reconciled += 1
                        log.info(
                            "recovery.reconciled_output",
                            job_id=state.job_id,
                            source_file=source_file,
                        )
                        if is_last and enqueue_finalize is not None:
                            try:
                                enqueue_finalize(state.job_id)
                            except Exception:
                                log.exception(
                                    "recovery.finalize_reenqueue_failed",
                                    job_id=state.job_id,
                                )
                            else:
                                finalize_reenqueued += 1
                                log.info("recovery.finalize_reenqueued", job_id=state.job_id)
                        continue
                    # Corrupt/truncated output (crash mid-write, disk error) —
                    # remove it and fall through to the normal re-enqueue path.
                    out_path.unlink(missing_ok=True)
                    log.info(
                        "recovery.invalid_output_removed",
                        job_id=state.job_id,
                        source_file=source_file,
                    )
                if sub.status == "done":
                    continue
                try:
                    enqueue_subtask(state.job_id, source_file)
                except Exception:
                    log.exception(
                        "recovery.enqueue_failed",
                        job_id=state.job_id,
                        source_file=source_file,
                    )
                    enqueue_failed += 1
                    continue
                count += 1

            # Refresh redis cache from disk (in case redis volume was lost).
            job_service.redis.set(
                f"job:{state.job_id}",
                state.model_dump_json(),
            )

        # Finalize backstop: a job whose subtasks are all terminal but whose
        # zip never got packed (e.g. the last subtask's own enqueue_finalize
        # call was itself lost to a crash) would otherwise sit forever with
        # no worker ever re-attempting the pack step.
        if enqueue_finalize is not None and not is_cancelled:
            total = state.total
            terminal_subtasks = state.done + state.failed
            all_failed = total > 0 and state.failed == total
            if total > 0 and terminal_subtasks == total and not all_failed:
                zip_path = child / "result.zip"
                if not zip_path.exists():
                    try:
                        enqueue_finalize(state.job_id)
                    except Exception:
                        log.exception("recovery.finalize_reenqueue_failed", job_id=state.job_id)
                    else:
                        finalize_reenqueued += 1
                        log.info("recovery.finalize_reenqueued", job_id=state.job_id)

    if count or enqueue_failed or finalize_reenqueued or reconciled:
        log.info(
            "recovery.resumed",
            subtasks=count,
            enqueue_failed=enqueue_failed,
            finalize_reenqueued=finalize_reenqueued,
            reconciled=reconciled,
        )
    return count
