"""RQ worker entrypoint.

Run via `python -m app.workers.run`. Spins up `RQ_WORKERS` workers and
calls recovery_service once at startup so any unfinished jobs from a
prior run get re-queued.
"""

from __future__ import annotations

import os
import uuid
from multiprocessing import Process

from redis import Redis
from rq import Worker

from ..logging_config import configure_logging
from ..services.job_service import JobService
from ..services.recovery_service import scan_and_resume
from ..settings import get_settings
from .queue import QUEUE_NAME, enqueue_subtask, make_queue


def _worker_loop(redis_url: str, worker_id: int) -> None:
    # Unique name per process so a previous unclean shutdown doesn't block startup
    # (RQ tracks active workers by name in Redis).
    redis = Redis.from_url(redis_url)
    name = f"worker-{worker_id}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    worker = Worker([QUEUE_NAME], connection=redis, name=name)
    worker.work(with_scheduler=False)


def main() -> None:
    configure_logging()
    settings = get_settings()
    redis = Redis.from_url(settings.redis_url)
    queue = make_queue(redis, settings)
    job_svc = JobService(redis=redis, jobs_dir=settings.jobs_dir)

    # Resume unfinished work before accepting new subtasks.
    scan_and_resume(
        jobs_dir=settings.jobs_dir,
        job_service=job_svc,
        enqueue_subtask=lambda jid, src: enqueue_subtask(queue, jid, src),
    )

    if settings.rq_workers <= 1:
        _worker_loop(settings.redis_url, 0)
        return

    procs = [
        Process(target=_worker_loop, args=(settings.redis_url, i), daemon=False)
        for i in range(settings.rq_workers)
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join()


if __name__ == "__main__":
    main()
