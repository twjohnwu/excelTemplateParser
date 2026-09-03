"""Deterministic-id + dedup tests for `app/workers/queue.py`.

Uses a real `rq.Queue` bound to fakeredis (no worker running, so enqueued
jobs stay QUEUED — exactly the state `_is_duplicate` needs to detect).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from rq import Queue
from rq.job import Job, JobStatus

from app.workers.queue import enqueue_finalize, enqueue_subtask


def make_queue(redis_client):
    return Queue("subtasks", connection=redis_client, default_timeout=600)


def test_enqueue_subtask_second_call_is_deduped(redis_client):
    queue = make_queue(redis_client)
    enqueue_subtask(queue, "job1", "orders.xlsx")
    result = enqueue_subtask(queue, "job1", "orders.xlsx")
    assert result is None
    assert len(queue.job_ids) == 1


def test_enqueue_finalize_uses_expected_id(redis_client):
    queue = make_queue(redis_client)
    enqueue_finalize(queue, "job1")
    assert queue.job_ids == ["job1__finalize"]


def test_enqueue_finalize_second_call_is_deduped(redis_client):
    queue = make_queue(redis_client)
    enqueue_finalize(queue, "job1")
    result = enqueue_finalize(queue, "job1")
    assert result is None
    assert len(queue.job_ids) == 1


def test_enqueue_subtask_distinct_cjk_names_get_distinct_ids(redis_client):
    queue = make_queue(redis_client)
    enqueue_subtask(queue, "job1", "客戶.xlsx")
    enqueue_subtask(queue, "job1", "廠商.xlsx")
    assert len(queue.job_ids) == 2
    assert len(set(queue.job_ids)) == 2


def test_enqueue_subtask_reclaims_stale_started_job(redis_client):
    queue = make_queue(redis_client)
    enqueue_subtask(queue, "job1", "orders.xlsx")
    rq_id = queue.job_ids[0]
    job = Job.fetch(rq_id, connection=redis_client)
    job.set_status(JobStatus.STARTED)
    job.heartbeat(datetime.now(UTC) - timedelta(minutes=5), 30)
    job.save()

    enqueue_subtask(queue, "job1", "orders.xlsx")

    refetched = Job.fetch(rq_id, connection=redis_client)
    assert refetched.get_status(refresh=True) == JobStatus.QUEUED


def test_enqueue_subtask_skips_fresh_started_job(redis_client):
    queue = make_queue(redis_client)
    enqueue_subtask(queue, "job1", "orders.xlsx")
    rq_id = queue.job_ids[0]
    job = Job.fetch(rq_id, connection=redis_client)
    job.set_status(JobStatus.STARTED)
    job.heartbeat(datetime.now(UTC), 30)
    job.save()

    enqueue_subtask(queue, "job1", "orders.xlsx")

    # Still just the one job record, still STARTED — not touched.
    refetched = Job.fetch(rq_id, connection=redis_client)
    assert refetched.get_status(refresh=True) == JobStatus.STARTED


def test_enqueue_subtask_over_finished_job_drops_stale_result(redis_client):
    """A re-enqueue over a FINISHED rq id must not inherit the old run's
    result/TTL — the old job record is deleted first."""
    queue = make_queue(redis_client)
    enqueue_subtask(queue, "job1", "orders.xlsx")
    rq_id = queue.job_ids[0]
    job = Job.fetch(rq_id, connection=redis_client)
    job.set_status(JobStatus.FINISHED)
    job._result = "stale result from a previous run"
    job.save()

    enqueue_subtask(queue, "job1", "orders.xlsx")

    refetched = Job.fetch(rq_id, connection=redis_client)
    assert refetched.get_status(refresh=True) == JobStatus.QUEUED
    assert refetched.result is None


def test_enqueue_subtask_continues_when_stale_delete_raises(redis_client, monkeypatch):
    """rq==2.8.0's Job.delete() can raise ValueError when the job's Execution
    record is already gone — that must not abort the whole recovery scan
    loop (it previously propagated straight out of enqueue_subtask)."""
    queue = make_queue(redis_client)
    enqueue_subtask(queue, "job1", "orders.xlsx")
    rq_id = queue.job_ids[0]
    job = Job.fetch(rq_id, connection=redis_client)
    job.set_status(JobStatus.STARTED)
    job.heartbeat(datetime.now(UTC) - timedelta(minutes=5), 30)
    job.save()

    from rq.job import Job as JobClass
    def _raise_delete(self, *a, **k):
        raise ValueError("Execution … not found in Redis")
    monkeypatch.setattr(JobClass, "delete", _raise_delete)

    # Must not raise: the stale-STARTED reclaim's delete() is guarded.
    enqueue_subtask(queue, "job1", "orders.xlsx")

    refetched = Job.fetch(rq_id, connection=redis_client)
    assert refetched.get_status(refresh=True) == JobStatus.QUEUED
