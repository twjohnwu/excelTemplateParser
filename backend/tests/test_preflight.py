import pytest

from app.api.jobs import _collect_required_columns
from app.core import preflight
from app.core.exceptions import TemplateInvalid
from app.schemas import ConfigSchema


def test_preflight_passes(orders_xlsx):
    preflight.preflight_check(
        orders_xlsx, sheet="訂單", header_row=1,
        required_columns=["單號", "客戶代號"],
    )


def test_preflight_missing_sheet(orders_xlsx):
    with pytest.raises(TemplateInvalid) as exc_info:
        preflight.preflight_check(orders_xlsx, sheet="不存在", header_row=1, required_columns=["x"])
    assert "不存在" in exc_info.value.user_message


def test_preflight_missing_column(orders_xlsx):
    with pytest.raises(TemplateInvalid) as exc_info:
        preflight.preflight_check(
            orders_xlsx, sheet="訂單", header_row=1,
            required_columns=["單號", "沒這個"],
        )
    assert "沒這個" in exc_info.value.user_message


def test_preflight_corrupt_file(tmp_path):
    bad = tmp_path / "bad.xlsx"
    bad.write_bytes(b"not an xlsx")
    with pytest.raises(TemplateInvalid):
        preflight.preflight_check(bad, sheet="x", header_row=1, required_columns=[])


def test_preflight_invalid_header_row(orders_xlsx):
    with pytest.raises(TemplateInvalid):
        preflight.preflight_check(orders_xlsx, sheet="訂單", header_row=0, required_columns=[])


def test_preflight_header_row_beyond_end(orders_xlsx):
    with pytest.raises(TemplateInvalid):
        preflight.preflight_check(orders_xlsx, sheet="訂單", header_row=99, required_columns=[])


def _config(mappings):
    return ConfigSchema.model_validate({
        "version": "1.0",
        "name": "demo",
        "target_template": {"sheet": "out", "header_row": 1, "columns": ["a"]},
        "sources": [
            {"alias": "primary", "role": "primary", "sheet": "s", "header_row": 1},
            {"alias": "meta", "role": "lookup", "sheet": "s", "header_row": 1},
        ],
        "joins": [],
        "mappings": mappings,
    })


def test_collect_skips_literal_only_mapping():
    cfg = _config([
        {"target": "a", "source": "primary.col"},
        {"target": "b", "literal": "fixed"},
    ])
    required = _collect_required_columns(cfg)
    assert required == {"primary": {"col"}}


def test_collect_skips_source_cell_mapping():
    cfg = _config([
        {"target": "a", "source": "primary.col"},
        {"target": "b", "source_cell": {"alias": "meta", "address": "A3"}},
    ])
    required = _collect_required_columns(cfg)
    # source_cell adds no column requirement — only `primary.col` from the
    # source mapping should be required.
    assert required == {"primary": {"col"}}


def test_df_needed_excludes_source_cell_only_alias():
    from app.workers.tasks import df_needed_aliases

    cfg = _config([
        {"target": "a", "source": "primary.col"},
        {"target": "b", "source_cell": {"alias": "meta", "address": "A3"}},
    ])
    needed = df_needed_aliases(cfg)
    # primary is always needed; meta is source_cell-only → excluded.
    assert needed == {"primary"}


def test_df_needed_includes_alias_used_in_conditions():
    from app.workers.tasks import df_needed_aliases

    cfg = _config([
        {
            "target": "a",
            "literal": "x",
            "conditions": [{"field": "meta.flag", "op": "==", "value": "y"}],
        },
    ])
    needed = df_needed_aliases(cfg)
    assert "meta" in needed


def test_collect_handles_mixed_modes_without_crashing():
    cfg = _config([
        {"target": "a", "literal": "x"},
        {"target": "b", "source_cell": {"alias": "meta", "address": "B5"}},
    ])
    # No source-mode mapping → nothing required (but must not raise).
    required = _collect_required_columns(cfg)
    assert dict(required) == {}
