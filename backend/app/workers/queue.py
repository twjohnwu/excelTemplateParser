"""Thin RQ wrapper: build a queue from settings + enqueue helpers.

Keeps RQ details out of API code paths.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

import structlog
from redis import Redis
from redis.exceptions import RedisError
from rq import Queue
from rq.exceptions import NoSuchJobError
from rq.job import Job, JobStatus

from ..settings import Settings, get_settings

QUEUE_NAME = "subtasks"

# A STARTED job whose worker died (kill -9, OOM) stops refreshing its
# heartbeat but RQ never flips its status away from STARTED on its own —
# without this, `_is_duplicate` would refuse to re-enqueue it forever.
# The worker refreshes the heartbeat every `job_monitoring_interval`
# (RQ default 30s, verified rq==2.8.0's Worker.monitor_work_horse), so a gap
# well past that is a reliable "the worker is gone" signal.
STALE_STARTED_SECONDS = 90

log = structlog.get_logger(__name__)

# Statuses under which an already-fetched job is still pending/in-flight —
# re-enqueueing under the same id would create a duplicate run. STARTED is
# handled separately (see `_is_duplicate`) since a stale STARTED job must be
# reclaimed rather than treated as permanently active.
_ACTIVE_STATUSES = {
    JobStatus.QUEUED,
    JobStatus.SCHEDULED,
    JobStatus.DEFERRED,
}

# RQ's Job.id validator only accepts [A-Za-z0-9_-]+ (rq.job.JOB_ID_PATTERN,
# verified rq==2.8.0) — no colons or dots. A naive character-substitution
# sanitizer of `source_file` collapses distinct non-ASCII names (e.g. two
# different CJK filenames) onto the same id, silently dropping one subtask.
# Hashing the raw name sidesteps that: the alphabet stays id-safe and
# collisions become cryptographically negligible instead of common.
def _hash_name(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def make_queue(redis: Redis, settings: Settings | None = None) -> Queue:
    s = settings or get_settings()
    return Queue(
        QUEUE_NAME,
        connection=redis,
        default_timeout=s.job_timeout_min * 60,
    )


def _delete_stale_job(job: Job, rq_id: str, reason: str) -> None:
    """Best-effort delete of a stale/terminal job record.

    rq==2.8.0's `Job.delete()` can raise `ValueError` when the job's
    Execution record is already gone (observed in production) — a delete
    failure here must never abort the caller's enqueue attempt, so any
    exception is logged and swallowed.
    """
    try:
        job.delete()
    except Exception as exc:
        log.warning("enqueue_stale_delete_failed", rq_id=rq_id, reason=reason, error=str(exc))


def _is_duplicate(queue: Queue, rq_id: str) -> bool:
    """Check whether `rq_id` already denotes an active (non-terminal) job.

    Falls back to "not a duplicate" if the queue has no usable connection
    (e.g. a test double) or the lookup otherwise fails — enqueueing is the
    safe default in that case, matching prior behaviour.

    STARTED is special-cased: RQ never moves a job off STARTED just because
    its worker died, so a STARTED job is only treated as active while its
    heartbeat is fresh. A stale one is reclaimed (its old record is deleted
    before the caller re-enqueues, per the fakeredis probe in queue.py's
    dispatch notes — re-enqueueing over a live job_id without deleting first
    leaves a duplicate entry in the queue's job list).

    Any other terminal status (FINISHED/FAILED/STOPPED/CANCELED) is also
    deleted before returning "not a duplicate": RQ does not reset a job's
    result/TTL fields when `enqueue()` reuses an existing job_id, so
    skipping this delete would let a re-enqueued job inherit its previous
    run's result and expiry.
    """
    connection = getattr(queue, "connection", None)
    if connection is None:
        return False
    try:
        job = Job.fetch(rq_id, connection=connection)
    except NoSuchJobError:
        return False
    except RedisError as exc:
        log.warning("enqueue_dedupe_lookup_failed", rq_id=rq_id, error=str(exc))
        return False
    status = job.get_status(refresh=False)
    if status in _ACTIVE_STATUSES:
        return True
    if status == JobStatus.STARTED:
        heartbeat = getattr(job, "last_heartbeat", None)
        if heartbeat is None:
            return False
        age = (datetime.now(UTC) - heartbeat).total_seconds()
        if age < STALE_STARTED_SECONDS:
            return True
        log.warning("enqueue_reclaim_stale_started", rq_id=rq_id, age_seconds=age)
        _delete_stale_job(job, rq_id, "stale_started")
        return False
    _delete_stale_job(job, rq_id, f"terminal_{status}")
    return False


def enqueue_subtask(queue: Queue, job_id: str, source_file: str) -> None:
    rq_id = f"{job_id}__sub__{_hash_name(source_file)}"
    if _is_duplicate(queue, rq_id):
        log.info("enqueue_skipped_duplicate", rq_id=rq_id, job_id=job_id)
        return None
    queue.enqueue(
        "app.workers.tasks.run_subtask",
        kwargs={"job_id": job_id, "source_file": source_file},
        job_timeout=queue._default_timeout,
        retry=None,
        job_id=rq_id,
    )


def enqueue_finalize(queue: Queue, job_id: str) -> None:
    rq_id = f"{job_id}__finalize"
    if _is_duplicate(queue, rq_id):
        log.info("enqueue_skipped_duplicate", rq_id=rq_id, job_id=job_id)
        return None
    queue.enqueue(
        "app.workers.tasks.finalize_job",
        kwargs={"job_id": job_id},
        job_id=rq_id,
    )
