"""FastAPI dependency providers.

Wired in `main.py`; tests override these in `app.dependency_overrides`.
"""

from __future__ import annotations

from functools import lru_cache

from fastapi import Depends, Request
from redis import Redis
from rq import Queue

from .services.cleanup_service import CleanupService
from .services.config_service import ConfigService
from .services.job_service import JobService
from .settings import Settings, get_settings
from .workers.queue import make_queue


@lru_cache
def _redis_pool(redis_url: str) -> Redis:
    return Redis.from_url(redis_url)


def get_redis(settings: Settings = Depends(get_settings)) -> Redis:
    return _redis_pool(settings.redis_url)


def get_queue(redis: Redis = Depends(get_redis), settings: Settings = Depends(get_settings)) -> Queue:
    return make_queue(redis, settings)


def get_config_service(
    redis: Redis = Depends(get_redis),
    settings: Settings = Depends(get_settings),
) -> ConfigService:
    return ConfigService(redis=redis, configs_dir=settings.configs_dir)


def get_job_service(
    redis: Redis = Depends(get_redis),
    settings: Settings = Depends(get_settings),
) -> JobService:
    return JobService(redis=redis, jobs_dir=settings.jobs_dir)


def get_cleanup_service(
    redis: Redis = Depends(get_redis),
    settings: Settings = Depends(get_settings),
) -> CleanupService:
    return CleanupService(
        redis=redis,
        jobs_dir=settings.jobs_dir,
        grace_minutes=settings.download_grace_minutes,
        retention_hours=settings.job_retention_hours,
    )


def get_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")
