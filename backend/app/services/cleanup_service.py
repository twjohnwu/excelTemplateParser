"""Job artifact cleanup: download-triggered deletes, grace expiry, and TTL purge.

Three entry points:

- `delete_job(id)`         — immediate, used after a successful download or cancel
- `purge_grace_expired()`  — every 10 min, deletes jobs whose download grace ended
- `purge_old_jobs(...)`    — every hour, deletes jobs older than the retention window
"""

from __future__ import annotations

import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

import structlog
from redis import Redis

from ..schemas import JobState

log = structlog.get_logger(__name__)


class CleanupService:
    def __init__(
        self,
        redis: Redis,
        jobs_dir: Path,
        grace_minutes: int = 60,
        retention_hours: int = 24,
    ) -> None:
        self.redis = redis
        self.dir = jobs_dir
        self.grace_minutes = grace_minutes
        self.retention_hours = retention_hours

    # ---- direct delete ----

    def delete_job(self, job_id: str) -> bool:
        """Delete on-disk artifacts + all Redis keys for a job.

        Returns True if anything was deleted.
        """
        job_dir = self.dir / job_id
        deleted = False
        if job_dir.exists():
            shutil.rmtree(job_dir)
            deleted = True

        # Wipe every redis key whose name starts with job:{id}
        keys = list(self.redis.scan_iter(match=f"job:{job_id}*"))
        if keys:
            self.redis.delete(*keys)
            deleted = True

        if deleted:
            log.info("cleanup.deleted", job_id=job_id)
        return deleted

    # ---- scheduled sweeps ----

    def purge_grace_expired(self) -> int:
        """Delete jobs whose download grace window has passed.

        Returns the count deleted.
        """
        if not self.dir.exists():
            return 0
        now = datetime.now(UTC)
        cutoff = now - timedelta(minutes=self.grace_minutes)
        count = 0
        for state in self._iter_states():
            if state.download_started_at is None:
                continue
            started = _parse_iso(state.download_started_at)
            if started <= cutoff:
                if self.delete_job(state.job_id):
                    count += 1
        if count:
            log.info("cleanup.grace_expired", deleted=count)
        return count

    def purge_old_jobs(self, *, older_than_hours: int | None = None) -> int:
        """Delete jobs older than the retention window (regardless of download state)."""
        if not self.dir.exists():
            return 0
        hours = older_than_hours if older_than_hours is not None else self.retention_hours
        cutoff = datetime.now(UTC) - timedelta(hours=hours)
        count = 0
        for state in self._iter_states():
            created = _parse_iso(state.created_at)
            if created <= cutoff:
                if self.delete_job(state.job_id):
                    count += 1
        if count:
            log.info("cleanup.retention", deleted=count, threshold_hours=hours)
        return count

    # ---- internals ----

    def _iter_states(self):
        for child in self.dir.iterdir():
            state_file = child / "state.json"
            if not state_file.exists():
                continue
            try:
                yield JobState.model_validate_json(state_file.read_text("utf-8"))
            except Exception:
                log.warning("cleanup.bad_state_json", path=str(state_file))


def _parse_iso(s: str) -> datetime:
    # Pydantic stores tz-aware ISO strings; datetime.fromisoformat handles them on 3.11+.
    return datetime.fromisoformat(s)
