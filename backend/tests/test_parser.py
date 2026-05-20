import pytest

from app.core import parser
from app.core.exceptions import TemplateInvalid


def test_list_sheets(orders_xlsx):
    assert parser.list_sheets(orders_xlsx) == ["訂單"]


def test_preview_rows(orders_xlsx):
    rows = parser.preview_rows(orders_xlsx, "訂單", count=10)
    assert rows[0] == ["單號", "客戶代號", "狀態", "總額"]
    assert rows[1] == ["A001", "C1", "成立", 1000]
    assert len(rows) == 4  # header + 3 data rows


def test_preview_rows_with_start(orders_xlsx):
    rows = parser.preview_rows(orders_xlsx, "訂單", start=2, count=10)
    assert rows[0] == ["A001", "C1", "成立", 1000]


def test_parse_basic(orders_xlsx):
    result = parser.parse(orders_xlsx, "訂單", header_row=1)
    assert result.headers == ["單號", "客戶代號", "狀態", "總額"]
    assert len(result.df) == 3
    assert result.df.iloc[0]["單號"] == "A001"


def test_parse_skips_metadata_rows(make_xlsx):
    path = make_xlsx({
        "Sheet1": [
            ["公司報表", None, None],
            ["產生日期：2025-05-01", None, None],
            [None, None, None],
            ["欄A", "欄B", "欄C"],
            [1, 2, 3],
            [4, 5, 6],
        ]
    })
    result = parser.parse(path, "Sheet1", header_row=4)
    assert result.headers == ["欄A", "欄B", "欄C"]
    assert len(result.df) == 2
    assert list(result.df.iloc[0]) == [1, 2, 3]


def test_parse_missing_sheet_raises(orders_xlsx):
    with pytest.raises(TemplateInvalid) as exc_info:
        parser.parse(orders_xlsx, "不存在", header_row=1)
    assert "不存在" in exc_info.value.user_message


def test_parse_corrupt_file_raises(tmp_path):
    bad = tmp_path / "bad.xlsx"
    bad.write_bytes(b"this is not an xlsx")
    with pytest.raises(TemplateInvalid):
        parser.parse(bad, "Sheet1", header_row=1)


def test_parse_invalid_header_row(orders_xlsx):
    with pytest.raises(TemplateInvalid):
        parser.parse(orders_xlsx, "訂單", header_row=0)


def test_parse_header_row_beyond_end(orders_xlsx):
    with pytest.raises(TemplateInvalid) as exc_info:
        parser.parse(orders_xlsx, "訂單", header_row=99)
    assert "99" in exc_info.value.user_message
