"""FastAPI entry: middleware stack, routers, lifespan (recovery + scheduler)."""

from __future__ import annotations

from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from redis import Redis

from . import errors
from .api import configs as configs_api
from .api import jobs as jobs_api
from .api import templates as templates_api
from .logging_config import configure_logging
from .middleware.request_id import RequestIdMiddleware
from .middleware.upload_limit import UploadSizeLimitMiddleware
from .services.cleanup_service import CleanupService
from .services.job_service import JobService
from .services.recovery_service import scan_and_resume
from .services.scheduler import build_scheduler
from .settings import get_settings
from .workers.queue import enqueue_subtask, make_queue

log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    settings = get_settings()
    redis = Redis.from_url(settings.redis_url)
    job_svc = JobService(redis=redis, jobs_dir=settings.jobs_dir)
    cleanup = CleanupService(
        redis=redis,
        jobs_dir=settings.jobs_dir,
        grace_minutes=settings.download_grace_minutes,
        retention_hours=settings.job_retention_hours,
    )
    queue = make_queue(redis, settings)

    # 1) recovery — re-enqueue unfinished subtasks
    try:
        scan_and_resume(
            jobs_dir=settings.jobs_dir,
            job_service=job_svc,
            enqueue_subtask=lambda jid, src: enqueue_subtask(queue, jid, src),
        )
    except Exception:
        log.exception("lifespan.recovery_failed")

    # 2) one-shot cleanup at startup (covers downtime overlap with retention)
    try:
        cleanup.purge_grace_expired()
        cleanup.purge_old_jobs()
    except Exception:
        log.exception("lifespan.startup_cleanup_failed")

    # 3) recurring scheduler
    scheduler = build_scheduler(cleanup)
    scheduler.start()

    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="excelTemplateParser", lifespan=lifespan)

    app.add_middleware(UploadSizeLimitMiddleware, max_bytes=settings.max_upload_mb * 1024 * 1024)
    app.add_middleware(RequestIdMiddleware)

    errors.install(app)

    app.include_router(templates_api.router)
    app.include_router(configs_api.router)
    app.include_router(jobs_api.router)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    return app


app = create_app()
