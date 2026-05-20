"""Thin RQ wrapper: build a queue from settings + enqueue helpers.

Keeps RQ details out of API code paths.
"""

from __future__ import annotations

from redis import Redis
from rq import Queue

from ..settings import Settings, get_settings

QUEUE_NAME = "subtasks"


def make_queue(redis: Redis, settings: Settings | None = None) -> Queue:
    s = settings or get_settings()
    return Queue(
        QUEUE_NAME,
        connection=redis,
        default_timeout=s.job_timeout_min * 60,
    )


def enqueue_subtask(queue: Queue, job_id: str, source_file: str) -> None:
    queue.enqueue(
        "app.workers.tasks.run_subtask",
        kwargs={"job_id": job_id, "source_file": source_file},
        job_timeout=queue._default_timeout,
        retry=None,
    )


def enqueue_finalize(queue: Queue, job_id: str) -> None:
    queue.enqueue(
        "app.workers.tasks.finalize_job",
        kwargs={"job_id": job_id},
    )
