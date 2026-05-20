import pytest

from app.schemas import ConfigSchema
from app.services.config_service import ConfigExists, ConfigNotFound, ConfigService


def _config(name: str = "demo") -> ConfigSchema:
    return ConfigSchema.model_validate({
        "name": name,
        "target_template": {
            "sheet": "Sheet1", "header_row": 1, "columns": ["a"],
        },
        "sources": [{"alias": "x", "role": "primary", "sheet": "S", "header_row": 1}],
        "joins": [],
        "mappings": [{"target": "a", "source": "x.a"}],
    })


@pytest.fixture
def svc(redis_client, tmp_path):
    return ConfigService(redis=redis_client, configs_dir=tmp_path / "configs")


def test_save_then_get_round_trip(svc):
    svc.save(_config())
    got = svc.get("demo")
    assert got.name == "demo"


def test_save_creates_disk_file(svc, tmp_path):
    svc.save(_config())
    assert (tmp_path / "configs" / "demo.json").exists()


def test_save_indexes_in_redis(svc, redis_client):
    svc.save(_config())
    assert redis_client.sismember("configs:index", "demo")
    assert redis_client.get("config:demo") is not None


def test_save_duplicate_raises(svc):
    svc.save(_config())
    with pytest.raises(ConfigExists):
        svc.save(_config())


def test_save_overwrite_allowed(svc):
    svc.save(_config())
    svc.save(_config(), overwrite=True)  # no raise


def test_get_missing_raises(svc):
    with pytest.raises(ConfigNotFound):
        svc.get("nope")


def test_get_falls_back_to_disk_when_redis_empty(svc, redis_client):
    svc.save(_config())
    # Simulate Redis volume loss.
    redis_client.flushall()
    got = svc.get("demo")
    assert got.name == "demo"
    # And restored to Redis as a side effect.
    assert redis_client.get("config:demo") is not None


def test_list_unions_redis_and_disk(svc, redis_client, tmp_path):
    svc.save(_config("a"))
    svc.save(_config("b"))
    redis_client.flushall()
    # Disk-only entries still surface.
    assert svc.list() == ["a", "b"]


def test_delete_removes_both(svc, redis_client, tmp_path):
    svc.save(_config())
    svc.delete("demo")
    assert not (tmp_path / "configs" / "demo.json").exists()
    assert not redis_client.sismember("configs:index", "demo")


def test_exists(svc):
    assert not svc.exists("demo")
    svc.save(_config())
    assert svc.exists("demo")
