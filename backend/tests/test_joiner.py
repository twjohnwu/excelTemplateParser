import pandas as pd
import pytest

from app.core import joiner
from app.core.exceptions import JoinKeyMissing


@pytest.fixture
def sources():
    return {
        "orders": pd.DataFrame({
            "單號": ["A001", "A002", "A003"],
            "客戶代號": ["C1", "C2", "C1"],
            "狀態": ["成立", "取消", "成立"],
            "總額": [1000, 500, 2500],
        }),
        "customers": pd.DataFrame({
            "代號": ["C1", "C2"],
            "名稱": ["客戶一", "客戶二"],
            "業務員代號": ["S1", "S2"],
        }),
        "sales": pd.DataFrame({
            "代號": ["S1", "S2"],
            "姓名": ["張三", "李四"],
        }),
    }


def test_no_joins_single_source():
    orders = pd.DataFrame({"a": [1, 2]})
    out = joiner.join({"orders": orders}, [])
    assert list(out.columns) == ["orders.a"]


def test_no_joins_multiple_sources_broadcasts_single_row():
    # Two sources, no joins: first is the base, second has 1 row → broadcast as constant.
    out = joiner.join(
        {"a": pd.DataFrame({"x": [1, 2, 3]}), "b": pd.DataFrame({"y": [99]})},
        [],
    )
    assert list(out.columns) == ["a.x", "b.y"]
    assert out["b.y"].tolist() == [99, 99, 99]


def test_unjoined_source_broadcasts_with_joins(sources):
    # Drop `sales` (which would otherwise be an unjoined multi-row source);
    # add a constant lookup that has no join rule but a single row.
    sources.pop("sales")
    sources["meta"] = pd.DataFrame({"批次日期": ["20260517"]})
    out = joiner.join(sources, [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "left"},
    ])
    assert "meta.批次日期" in out.columns
    assert out["meta.批次日期"].tolist() == ["20260517"] * 3


def test_unjoined_source_multiple_rows_raises():
    with pytest.raises(JoinKeyMissing) as exc_info:
        joiner.join(
            {
                "a": pd.DataFrame({"x": [1, 2]}),
                "b": pd.DataFrame({"y": [10, 20]}),
            },
            [],
        )
    assert "固定單欄" in exc_info.value.user_message


def test_unjoined_source_empty_raises():
    with pytest.raises(JoinKeyMissing) as exc_info:
        joiner.join(
            {
                "a": pd.DataFrame({"x": [1, 2]}),
                "b": pd.DataFrame({"y": []}),
            },
            [],
        )
    assert "沒有資料列" in exc_info.value.user_message


def test_single_join(sources):
    sources.pop("sales")  # not exercised by this test; would now error as unjoined multi-row
    out = joiner.join(sources, [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "left"},
    ])
    assert len(out) == 3
    assert "orders.單號" in out.columns
    assert "customers.名稱" in out.columns
    # row 0 should pick up 客戶一
    assert out.loc[out["orders.單號"] == "A001", "customers.名稱"].iloc[0] == "客戶一"


def test_chained_join(sources):
    out = joiner.join(sources, [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "left"},
        {"left": "customers.業務員代號", "right": "sales.代號", "type": "left"},
    ])
    assert "sales.姓名" in out.columns
    assert out.loc[out["orders.單號"] == "A001", "sales.姓名"].iloc[0] == "張三"
    assert out.loc[out["orders.單號"] == "A002", "sales.姓名"].iloc[0] == "李四"


def test_missing_left_column_raises(sources):
    with pytest.raises(JoinKeyMissing) as exc_info:
        joiner.join(sources, [
            {"left": "orders.不存在", "right": "customers.代號", "type": "left"},
        ])
    assert "不存在" in exc_info.value.user_message


def test_missing_right_column_raises(sources):
    with pytest.raises(JoinKeyMissing) as exc_info:
        joiner.join(sources, [
            {"left": "orders.客戶代號", "right": "customers.沒這個", "type": "left"},
        ])
    assert "沒這個" in exc_info.value.user_message


def test_inner_join_drops_unmatched(sources):
    sources.pop("sales")  # not exercised; would now error as unjoined multi-row
    # add an order with no matching customer
    sources["orders"] = pd.concat([
        sources["orders"],
        pd.DataFrame({"單號": ["A999"], "客戶代號": ["C9"], "狀態": ["成立"], "總額": [100]}),
    ], ignore_index=True)

    out = joiner.join(sources, [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "inner"},
    ])
    assert "A999" not in out["orders.單號"].tolist()


def test_outer_join_keeps_unmatched_from_both_sides(sources):
    sources.pop("sales")
    # add an order whose customer is not in customers (A999/C9)
    # and add a customer with no orders (C3)
    sources["orders"] = pd.concat([
        sources["orders"],
        pd.DataFrame({"單號": ["A999"], "客戶代號": ["C9"], "狀態": ["成立"], "總額": [100]}),
    ], ignore_index=True)
    sources["customers"] = pd.concat([
        sources["customers"],
        pd.DataFrame({"代號": ["C3"], "名稱": ["客戶三"], "業務員代號": ["S3"]}),
    ], ignore_index=True)

    out = joiner.join(sources, [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "outer"},
    ])

    # primary 那邊未匹配的 A999 還在；customers 那邊未匹配的 C3 也以 NaN 填 primary 欄
    assert "A999" in out["orders.單號"].tolist()
    assert "客戶三" in out["customers.名稱"].tolist()
    # 對 C3 來說，orders 欄應為 NaN
    c3_row = out[out["customers.名稱"] == "客戶三"]
    assert pd.isna(c3_row["orders.單號"].iloc[0])


def test_right_join_drives_from_lookup(sources):
    sources.pop("sales")
    # add a customer who has no orders
    sources["customers"] = pd.concat([
        sources["customers"],
        pd.DataFrame({"代號": ["C3"], "名稱": ["客戶三"], "業務員代號": ["S3"]}),
    ], ignore_index=True)

    out = joiner.join(sources, [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "right"},
    ])

    # right join: customers 為主，C3 留下；對它 orders 欄為 NaN
    assert "客戶三" in out["customers.名稱"].tolist()
    c3_row = out[out["customers.名稱"] == "客戶三"]
    assert pd.isna(c3_row["orders.單號"].iloc[0])


def test_outer_join_chained_with_two_lookups(sources):
    # sales 沒有 S3，但 customers 有 S3 的 reference → outer 串連時保留
    sources["customers"] = pd.concat([
        sources["customers"],
        pd.DataFrame({"代號": ["C3"], "名稱": ["客戶三"], "業務員代號": ["S3"]}),
    ], ignore_index=True)
    sources["orders"] = pd.concat([
        sources["orders"],
        pd.DataFrame({"單號": ["A004"], "客戶代號": ["C3"], "狀態": ["成立"], "總額": [800]}),
    ], ignore_index=True)

    out = joiner.join(sources, [
        {"left": "orders.客戶代號", "right": "customers.代號", "type": "outer"},
        {"left": "customers.業務員代號", "right": "sales.代號", "type": "outer"},
    ])

    # A004 → C3 → S3 但 sales 沒 S3 → sales.姓名 應為 NaN
    a004_row = out[out["orders.單號"] == "A004"]
    assert pd.isna(a004_row["sales.姓名"].iloc[0])
