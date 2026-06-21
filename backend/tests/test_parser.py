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


# ---------- iter_chunks (streaming) ----------


def test_iter_chunks_single_chunk(orders_xlsx):
    chunks = list(parser.iter_chunks(orders_xlsx, "訂單", header_row=1, chunk_size=100))
    assert len(chunks) == 1
    assert chunks[0].headers == ["單號", "客戶代號", "狀態", "總額"]
    assert len(chunks[0].df) == 3


def test_iter_chunks_splits_by_chunk_size(orders_xlsx):
    chunks = list(parser.iter_chunks(orders_xlsx, "訂單", header_row=1, chunk_size=2))
    # 3 data rows in batches of 2 → [2, 1]
    assert [len(c.df) for c in chunks] == [2, 1]
    # Every chunk carries the same headers.
    assert all(c.headers == ["單號", "客戶代號", "狀態", "總額"] for c in chunks)
    # Row order preserved across chunks.
    assert chunks[0].df.iloc[0]["單號"] == "A001"
    assert chunks[1].df.iloc[0]["單號"] == "A003"


def test_iter_chunks_skips_metadata_and_empty_rows(make_xlsx):
    path = make_xlsx({
        "Sheet1": [
            ["公司報表", None, None],
            ["欄A", "欄B", "欄C"],
            [1, 2, 3],
            [None, None, None],   # empty row dropped
            [4, 5, 6],
        ]
    })
    chunks = list(parser.iter_chunks(path, "Sheet1", header_row=2, chunk_size=1))
    assert [len(c.df) for c in chunks] == [1, 1]  # 2 data rows, empty dropped
    assert chunks[0].headers == ["欄A", "欄B", "欄C"]


def test_iter_chunks_pads_short_rows(make_xlsx):
    path = make_xlsx({"Sheet1": [["a", "b", "c"], [1, 2]]})  # short data row
    chunks = list(parser.iter_chunks(path, "Sheet1", header_row=1, chunk_size=10))
    assert list(chunks[0].df.iloc[0]) == [1, 2, None]


def test_iter_chunks_empty_data_yields_one_chunk(make_xlsx):
    path = make_xlsx({"Sheet1": [["a", "b"]]})  # header only, no data
    chunks = list(parser.iter_chunks(path, "Sheet1", header_row=1, chunk_size=10))
    assert len(chunks) == 1
    assert chunks[0].headers == ["a", "b"]
    assert len(chunks[0].df) == 0


def test_iter_chunks_equivalent_to_parse(orders_xlsx):
    import pandas as pd

    streamed = pd.concat(
        [c.df for c in parser.iter_chunks(orders_xlsx, "訂單", header_row=1, chunk_size=2)],
        ignore_index=True,
    )
    whole = parser.parse(orders_xlsx, "訂單", header_row=1).df
    pd.testing.assert_frame_equal(streamed, whole)


def test_iter_chunks_invalid_header_row_raises(orders_xlsx):
    with pytest.raises(TemplateInvalid):
        list(parser.iter_chunks(orders_xlsx, "訂單", header_row=0))


def test_iter_chunks_missing_sheet_raises(orders_xlsx):
    with pytest.raises(TemplateInvalid):
        list(parser.iter_chunks(orders_xlsx, "不存在", header_row=1))


def test_iter_chunks_header_row_beyond_end_raises(orders_xlsx):
    with pytest.raises(TemplateInvalid):
        list(parser.iter_chunks(orders_xlsx, "訂單", header_row=99))
