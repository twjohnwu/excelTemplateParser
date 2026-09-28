"""Regression tests for the streaming/full-load gate around unmatched-right joins.

`outer` (and `right`) joins can emit rows for lookup keys that don't exist in
the primary. When the primary is streamed in chunks, each chunk re-runs the
join against the *whole* lookup, so those unmatched rows get emitted once per
chunk instead of once overall (see `docs/decisions_log.md`). `_primary_is_join_base`
is the shared gate (`app/core/preview.py`) that must route such configs
through the full-load fallback instead of the streaming path.
"""

from __future__ import annotations

from collections import Counter

from openpyxl import load_workbook

from app.core.preview import _primary_is_join_base
from app.schemas import ConfigSchema
from app.workers import tasks as worker_tasks

N_PRIMARY = 25
N_LOOKUP = 30  # K001..K025 overlap with primary; K026..K030 are unmatched.


def _outer_join_config() -> ConfigSchema:
    return ConfigSchema.model_validate({
        "name": "outer-join-streaming",
        "target_template": {
            "sheet": "Sheet1", "header_row": 1, "columns": ["key"],
        },
        "sources": [
            {"alias": "primary", "role": "primary", "sheet": "Primary", "header_row": 1},
            {"alias": "lookup", "role": "lookup", "sheet": "Lookup", "header_row": 1},
        ],
        "joins": [
            {"left": "primary.key", "right": "lookup.key", "type": "outer"},
        ],
        "mappings": [
            {"target": "key", "source": "lookup.key"},
        ],
    })


def _left_join_config() -> ConfigSchema:
    config = _outer_join_config().model_dump()
    config["joins"][0]["type"] = "left"
    return ConfigSchema.model_validate(config)


def _right_join_config() -> ConfigSchema:
    config = _outer_join_config().model_dump()
    config["joins"][0]["type"] = "right"
    return ConfigSchema.model_validate(config)


def _read_key_column(out_path):
    wb = load_workbook(out_path, data_only=True)
    ws = wb["Sheet1"]
    return [ws.cell(r, 1).value for r in range(2, ws.max_row + 1)]


def test_outer_join_streamed_primary_does_not_duplicate_unmatched_lookup_rows(
    tmp_path, make_xlsx,
):
    """A chunked primary + an `outer` join must yield exactly one row per
    unmatched lookup key overall, not once per chunk (chunk_size=10 over 25
    primary rows previously fanned out 25 matched + 3*5 unmatched = 40 rows;
    with a fully-overlapping key range it fans out even further — see the
    module docstring)."""
    primary_rows = [["key", "val"]] + [[f"K{i:03d}", i] for i in range(1, N_PRIMARY + 1)]
    lookup_rows = [["key", "note"]] + [[f"K{i:03d}", f"n{i}"] for i in range(1, N_LOOKUP + 1)]
    target_rows = [["key"]]

    primary_xlsx = make_xlsx({"Primary": primary_rows}, filename="primary.xlsx")
    lookup_xlsx = make_xlsx({"Lookup": lookup_rows}, filename="lookup.xlsx")
    target_xlsx = make_xlsx({"Sheet1": target_rows}, filename="target.xlsx")

    job_dir = tmp_path / "job1"
    (job_dir / "uploads" / "primary").mkdir(parents=True)
    (job_dir / "uploads" / "lookup").mkdir(parents=True)
    (job_dir / "out").mkdir(parents=True)
    (job_dir / "uploads" / "target.xlsx").write_bytes(target_xlsx.read_bytes())
    (job_dir / "uploads" / "primary" / "primary.xlsx").write_bytes(primary_xlsx.read_bytes())
    (job_dir / "uploads" / "lookup" / "lookup.xlsx").write_bytes(lookup_xlsx.read_bytes())

    config = _outer_join_config()
    out_path = job_dir / "out" / "primary.xlsx.out.xlsx"

    worker_tasks._execute(job_dir, "primary.xlsx", config, out_path, chunk_size=10)

    keys = _read_key_column(out_path)
    assert len(keys) == N_LOOKUP, (
        f"expected exactly {N_LOOKUP} rows (25 matched + 5 unmatched lookup "
        f"rows, each once), got {len(keys)}"
    )
    counts = Counter(keys)
    assert all(c == 1 for c in counts.values()), f"a key was duplicated: {counts}"
    unmatched = {f"K{i:03d}" for i in range(N_PRIMARY + 1, N_LOOKUP + 1)}
    assert unmatched <= set(keys)


def test_primary_is_join_base_true_for_left_join():
    assert _primary_is_join_base(_left_join_config()) is True


def test_primary_is_join_base_false_for_outer_join():
    assert _primary_is_join_base(_outer_join_config()) is False


def test_primary_is_join_base_false_for_right_join():
    assert _primary_is_join_base(_right_join_config()) is False
