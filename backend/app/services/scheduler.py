"""APScheduler setup: in-process, async, registered in FastAPI lifespan.

Four recurring jobs:
- purge_grace_expired every 10 minutes
- purge_cancelled_jobs every 10 minutes (same cadence as the grace sweep)
- purge_old_jobs every hour
- resume (scan_and_resume backstop) every `resume_scan_seconds`
  (settings.RESUME_SCAN_SECONDS, optional)

The lifespan should also call both cleanup jobs once at startup so a long
downtime doesn't leave stale artifacts behind. The resume backstop exists
because a stale-STARTED subtask (its worker was killed) is only reclaimed
the next time `_is_duplicate` sees it — this periodic re-scan is what
guarantees that happens within `resume_scan_seconds`, even if the one-shot
startup scan ran before the worker died.
"""

from __future__ import annotations

from typing import Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .cleanup_service import CleanupService


def build_scheduler(
    cleanup: CleanupService,
    resume: Callable[[], None] | None = None,
    resume_scan_seconds: int = 120,
) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        cleanup.purge_grace_expired,
        trigger="interval",
        minutes=10,
        id="purge_grace_expired",
        replace_existing=True,
    )
    scheduler.add_job(
        cleanup.purge_cancelled_jobs,
        trigger="interval",
        minutes=10,
        id="purge_cancelled_jobs",
        replace_existing=True,
    )
    scheduler.add_job(
        cleanup.purge_old_jobs,
        trigger="interval",
        hours=1,
        id="purge_old_jobs",
        replace_existing=True,
    )
    if resume is not None:
        scheduler.add_job(
            resume,
            trigger="interval",
            seconds=resume_scan_seconds,
            id="resume_scan",
            replace_existing=True,
        )
    return scheduler
