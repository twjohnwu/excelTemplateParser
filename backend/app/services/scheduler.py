"""APScheduler setup: in-process, async, registered in FastAPI lifespan.

Two recurring jobs:
- purge_grace_expired every 10 minutes
- purge_old_jobs every hour

The lifespan should also call both once at startup so a long downtime
doesn't leave stale artifacts behind.
"""

from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .cleanup_service import CleanupService


def build_scheduler(cleanup: CleanupService) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        cleanup.purge_grace_expired,
        trigger="interval",
        minutes=10,
        id="purge_grace_expired",
        replace_existing=True,
    )
    scheduler.add_job(
        cleanup.purge_old_jobs,
        trigger="interval",
        hours=1,
        id="purge_old_jobs",
        replace_existing=True,
    )
    return scheduler
