"""Startup recovery: scan /data/jobs/* and re-enqueue subtasks for unfinished jobs.

Runs in the API lifespan (and again at worker start). Idempotent: if a
subtask's output xlsx already exists, the worker will skip it.
"""

from __future__ import annotations

from pathlib import Path

import structlog

from .job_service import JobService
from ..schemas import JobState

log = structlog.get_logger(__name__)


def scan_and_resume(
    jobs_dir: Path,
    job_service: JobService,
    enqueue_subtask,  # callable(job_id, source_file) -> None
) -> int:
    """Re-enqueue every pending/running subtask for non-terminal jobs.

    Returns the number of subtasks re-enqueued.
    """
    if not jobs_dir.exists():
        return 0

    count = 0
    for child in sorted(jobs_dir.iterdir()):
        state_file = child / "state.json"
        if not state_file.exists():
            continue
        try:
            state = JobState.model_validate_json(state_file.read_text("utf-8"))
        except Exception:
            log.warning("recovery.bad_state_json", path=str(state_file))
            continue

        if state.status in ("done", "failed", "cancelled"):
            continue

        out_dir = child / "out"
        for source_file, sub in state.subtasks.items():
            # Skip outputs that already exist (idempotency).
            if (out_dir / f"{source_file}.out.xlsx").exists():
                continue
            if sub.status == "done":
                continue
            enqueue_subtask(state.job_id, source_file)
            count += 1

        # Refresh redis cache from disk (in case redis volume was lost).
        job_service.redis.set(
            f"job:{state.job_id}",
            state.model_dump_json(),
        )

    if count:
        log.info("recovery.resumed", subtasks=count)
    return count
