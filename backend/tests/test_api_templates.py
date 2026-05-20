def test_parse_returns_sheets_and_preview(api_client, orders_xlsx):
    with open(orders_xlsx, "rb") as f:
        r = api_client.post(
            "/api/templates/parse",
            files={"file": ("orders.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["filename"] == "orders.xlsx"
    assert len(body["sheets"]) == 1
    sheet = body["sheets"][0]
    assert sheet["name"] == "訂單"
    assert sheet["preview_rows"][0] == ["單號", "客戶代號", "狀態", "總額"]


def test_parse_from_row_offsets(api_client, orders_xlsx):
    with open(orders_xlsx, "rb") as f:
        r = api_client.post(
            "/api/templates/parse?from_row=2",
            files={"file": ("orders.xlsx", f, "application/octet-stream")},
        )
    assert r.status_code == 200
    sheet = r.json()["sheets"][0]
    assert sheet["preview_starts_at"] == 2
    assert sheet["preview_rows"][0] == ["A001", "C1", "成立", 1000]


def test_parse_invalid_file_returns_422(api_client):
    r = api_client.post(
        "/api/templates/parse",
        files={"file": ("bad.xlsx", b"not an xlsx", "application/octet-stream")},
    )
    assert r.status_code == 422
    assert r.json()["code"] == "TemplateInvalid"
