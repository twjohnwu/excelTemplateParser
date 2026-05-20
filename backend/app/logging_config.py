"""Structlog configuration: JSON one-line-per-event output with shared context.

Logs from the API layer carry `request_id`; worker logs carry `job_id`
and `source_file`. Configure once at process startup.
"""

from __future__ import annotations

import logging
import os
import socket
import sys

import structlog


def configure_logging(level: str = "INFO") -> None:
    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)

    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        timestamper,
        structlog.processors.StackInfoRenderer(),
    ]

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )

    # Bind process-wide metadata once.
    structlog.contextvars.bind_contextvars(
        host=socket.gethostname(),
        service=os.environ.get("SERVICE_NAME", "excel-template-parser"),
    )
