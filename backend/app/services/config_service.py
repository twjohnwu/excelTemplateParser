"""Config CRUD: Redis (cache) + filesystem (source of truth).

Writes go to disk first, then Redis; reads prefer Redis then fall back to disk
(so a wiped Redis still serves recently-saved configs after worker restart).
"""

from __future__ import annotations

import json
from pathlib import Path

from redis import Redis

from ..schemas import ConfigSchema

CONFIG_KEY = "config:{name}"
CONFIG_INDEX = "configs:index"


class ConfigExists(Exception):
    """Raised by save() when name already exists and overwrite is False."""


class ConfigNotFound(Exception):
    pass


class ConfigService:
    def __init__(self, redis: Redis, configs_dir: Path) -> None:
        self.redis = redis
        self.dir = configs_dir
        self.dir.mkdir(parents=True, exist_ok=True)

    # ---- write ----

    def save(self, config: ConfigSchema, *, overwrite: bool = False) -> None:
        path = self._path(config.name)
        if not overwrite and (path.exists() or self.redis.sismember(CONFIG_INDEX, config.name)):
            raise ConfigExists(config.name)

        payload = config.model_dump_json(indent=2)
        # disk first (source of truth)
        path.write_text(payload, encoding="utf-8")
        # then redis
        pipe = self.redis.pipeline()
        pipe.set(CONFIG_KEY.format(name=config.name), payload)
        pipe.sadd(CONFIG_INDEX, config.name)
        pipe.execute()

    def delete(self, name: str) -> None:
        path = self._path(name)
        if path.exists():
            path.unlink()
        pipe = self.redis.pipeline()
        pipe.delete(CONFIG_KEY.format(name=name))
        pipe.srem(CONFIG_INDEX, name)
        pipe.execute()

    # ---- read ----

    def get(self, name: str) -> ConfigSchema:
        raw = self.redis.get(CONFIG_KEY.format(name=name))
        if raw is None:
            path = self._path(name)
            if not path.exists():
                raise ConfigNotFound(name)
            raw = path.read_text(encoding="utf-8")
            # rebuild redis cache silently
            self.redis.set(CONFIG_KEY.format(name=name), raw)
            self.redis.sadd(CONFIG_INDEX, name)
        elif isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return ConfigSchema.model_validate_json(raw)

    def list(self) -> list[str]:
        # Union of redis index and disk so disk-only entries surface too.
        redis_names: set[str] = {
            n.decode("utf-8") if isinstance(n, bytes) else n
            for n in self.redis.smembers(CONFIG_INDEX)
        }
        disk_names = {p.stem for p in self.dir.glob("*.json")}
        return sorted(redis_names | disk_names)

    def exists(self, name: str) -> bool:
        return bool(self.redis.sismember(CONFIG_INDEX, name)) or self._path(name).exists()

    # ---- internals ----

    def _path(self, name: str) -> Path:
        return self.dir / f"{name}.json"
