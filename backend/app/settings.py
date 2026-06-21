"""Environment-driven settings (12-factor)."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    data_dir: Path = Field(default=Path("./data"), alias="DATA_DIR")

    max_upload_mb: int = Field(default=50, alias="MAX_UPLOAD_MB")
    rq_workers: int = Field(default=4, alias="RQ_WORKERS")
    job_timeout_min: int = Field(default=10, alias="JOB_TIMEOUT_MIN")

    # Rows pulled into memory per streaming chunk when parsing the primary file.
    # Bounds peak memory for large inputs; lookup sources are still loaded whole.
    parse_chunk_size: int = Field(default=10000, alias="PARSE_CHUNK_SIZE")

    download_grace_minutes: int = Field(default=60, alias="DOWNLOAD_GRACE_MINUTES")
    job_retention_hours: int = Field(default=24, alias="JOB_RETENTION_HOURS")

    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @property
    def configs_dir(self) -> Path:
        return self.data_dir / "configs"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"


def get_settings() -> Settings:
    """Read once; callers may pass via DI or rely on module-level access."""
    return Settings()  # type: ignore[call-arg]
