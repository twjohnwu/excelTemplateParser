"""Custom exception hierarchy for core operations.

Boundary-based error handling: core layer raises these; worker and API
edges catch and translate. Each exception carries a user_message
(displayable to end users) and tech_detail (engineer-facing) plus
arbitrary context for structured logging.
"""

from __future__ import annotations


class CoreError(Exception):
    """Base for all expected errors raised by the core layer."""

    def __init__(self, user_message: str, tech_detail: str = "", **context: object) -> None:
        super().__init__(user_message)
        self.user_message = user_message
        self.tech_detail = tech_detail
        self.context = context


class ConfigError(CoreError):
    """Configuration JSON does not pass schema validation."""


class JoinKeyMissing(CoreError):
    """A join rule references a column that does not exist in its source."""


class MappingError(CoreError):
    """A mapping rule cannot be applied (bad operator, type mismatch, ...)."""


class RegexTimeout(CoreError):
    """A regex condition exceeded the per-cell evaluation budget."""


class WriterError(CoreError):
    """Failed to write the output xlsx (e.g., target template corrupted)."""


class TemplateInvalid(CoreError):
    """Uploaded xlsx is corrupt, not an xlsx, or missing required structure."""
