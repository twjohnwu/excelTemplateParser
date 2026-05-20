import pandas as pd
import pytest

from app.core import mapper
from app.core.exceptions import MappingError


@pytest.fixture
def joined():
    return pd.DataFrame({
        "orders.單號": ["A001", "A002", "A003"],
        "orders.狀態": ["成立", "取消", "成立"],
        "orders.總額": [1000, -50, 2500],
        "customers.名稱": ["客戶一", "客戶二", "客戶一"],
        "sales.姓名": ["張三", "李四", "張三"],
    })


def test_direct_mapping(joined):
    out = mapper.apply(joined, [
        {"target": "訂單編號", "source": "orders.單號"},
    ], target_columns=["訂單編號"])
    assert out["訂單編號"].tolist() == ["A001", "A002", "A003"]


def test_condition_not_equal_filters(joined):
    out = mapper.apply(joined, [
        {
            "target": "客戶名稱",
            "source": "customers.名稱",
            "conditions": [{"field": "orders.狀態", "op": "!=", "value": "取消"}],
            "default": "",
        },
    ], target_columns=["客戶名稱"])
    assert out["客戶名稱"].tolist() == ["客戶一", "", "客戶一"]


def test_condition_gte(joined):
    out = mapper.apply(joined, [
        {
            "target": "金額",
            "source": "orders.總額",
            "conditions": [{"field": "orders.總額", "op": ">=", "value": 0}],
            "default": 0,
        },
    ], target_columns=["金額"])
    assert out["金額"].tolist() == [1000, 0, 2500]


def test_condition_contains(joined):
    out = mapper.apply(joined, [
        {
            "target": "x",
            "source": "orders.單號",
            "conditions": [{"field": "customers.名稱", "op": "contains", "value": "一"}],
            "default": "",
        },
    ], target_columns=["x"])
    assert out["x"].tolist() == ["A001", "", "A003"]


def test_condition_in(joined):
    out = mapper.apply(joined, [
        {
            "target": "x",
            "source": "orders.單號",
            "conditions": [{"field": "sales.姓名", "op": "in", "value": ["張三"]}],
            "default": "",
        },
    ], target_columns=["x"])
    assert out["x"].tolist() == ["A001", "", "A003"]


def test_condition_regex(joined):
    out = mapper.apply(joined, [
        {
            "target": "x",
            "source": "orders.單號",
            "conditions": [{"field": "orders.單號", "op": "regex", "value": r"^A00[13]$"}],
            "default": "",
        },
    ], target_columns=["x"])
    assert out["x"].tolist() == ["A001", "", "A003"]


def test_multiple_conditions_are_anded(joined):
    out = mapper.apply(joined, [
        {
            "target": "x",
            "source": "orders.單號",
            "conditions": [
                {"field": "orders.狀態", "op": "!=", "value": "取消"},
                {"field": "orders.總額", "op": ">=", "value": 2000},
            ],
            "default": "",
        },
    ], target_columns=["x"])
    assert out["x"].tolist() == ["", "", "A003"]


def test_missing_source_column_raises(joined):
    with pytest.raises(MappingError) as exc_info:
        mapper.apply(joined, [
            {"target": "x", "source": "missing.col"},
        ], target_columns=["x"])
    # When the whole alias is absent (vs. just the column), the error should
    # explain the alias never made it into the merged result.
    assert "未進入合併結果" in exc_info.value.user_message


def test_source_cell_broadcasts_pinned_value(joined):
    out = mapper.apply(
        joined,
        [{"target": "批次日期", "source_cell": {"alias": "meta", "address": "A3"}}],
        target_columns=["批次日期"],
        pinned_cells={0: "20260517"},
    )
    assert out["批次日期"].tolist() == ["20260517"] * 3


def test_source_cell_with_conditions(joined):
    out = mapper.apply(
        joined,
        [
            {
                "target": "批次",
                "source_cell": {"alias": "meta", "address": "A3"},
                "conditions": [{"field": "orders.狀態", "op": "==", "value": "成立"}],
                "default": "—",
            },
        ],
        target_columns=["批次"],
        pinned_cells={0: "20260517"},
    )
    assert out["批次"].tolist() == ["20260517", "—", "20260517"]


def test_source_cell_without_pinned_value_broadcasts_none(joined):
    # If worker fails to resolve the cell, pinned_cells lacks the key — mapper
    # treats the value as None (default fallback) rather than crashing.
    out = mapper.apply(
        joined,
        [{"target": "批次", "source_cell": {"alias": "meta", "address": "A3"}}],
        target_columns=["批次"],
    )
    assert out["批次"].tolist() == [None, None, None]


def test_existing_alias_but_missing_column_raises(joined):
    # alias `orders` is in the joined df, but `這欄不存在` isn't.
    with pytest.raises(MappingError) as exc_info:
        mapper.apply(joined, [
            {"target": "x", "source": "orders.這欄不存在"},
        ], target_columns=["x"])
    assert "不存在" in exc_info.value.user_message
    assert "未進入合併結果" not in exc_info.value.user_message


def test_unsupported_operator_raises(joined):
    with pytest.raises(MappingError):
        mapper.apply(joined, [
            {
                "target": "x",
                "source": "orders.單號",
                "conditions": [{"field": "orders.狀態", "op": "??", "value": "x"}],
            },
        ], target_columns=["x"])


def test_target_without_mapping_gets_empty(joined):
    out = mapper.apply(joined, [
        {"target": "a", "source": "orders.單號"},
    ], target_columns=["a", "b"])
    assert out["b"].tolist() == ["", "", ""]


def test_target_column_order_preserved(joined):
    out = mapper.apply(joined, [
        {"target": "x", "source": "orders.單號"},
        {"target": "y", "source": "customers.名稱"},
    ], target_columns=["y", "x"])
    assert list(out.columns) == ["y", "x"]


def test_apply_includes_mappings_not_in_target_columns(joined):
    """A mapping whose target is missing from target_columns must still appear
    in the output (appended after the listed columns)."""
    out = mapper.apply(joined, [
        {"target": "a", "source": "orders.單號"},
        {"target": "b", "source": "customers.名稱"},
    ], target_columns=["a"])
    assert list(out.columns) == ["a", "b"]
    assert out["a"].tolist() == ["A001", "A002", "A003"]
    assert out["b"].tolist() == ["客戶一", "客戶二", "客戶一"]


def test_literal_value_mapping(joined):
    """A mapping with `literal` (no source) emits the same value for every row."""
    out = mapper.apply(joined, [
        {"target": "build", "literal": "系統建立"},
        {"target": "ver", "literal": 42},
    ], target_columns=["build", "ver"])
    assert out["build"].tolist() == ["系統建立"] * 3
    assert out["ver"].tolist() == [42] * 3


def test_literal_with_conditions(joined):
    """Conditions still gate literal mappings; failing rows fall back to default."""
    out = mapper.apply(joined, [
        {
            "target": "tag",
            "literal": "成立中",
            "conditions": [{"field": "orders.狀態", "op": "==", "value": "成立"}],
            "default": "",
        },
    ], target_columns=["tag"])
    assert out["tag"].tolist() == ["成立中", "", "成立中"]
