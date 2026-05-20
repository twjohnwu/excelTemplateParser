def _config(name: str = "demo") -> dict:
    return {
        "name": name,
        "target_template": {"sheet": "S", "header_row": 1, "columns": ["a"]},
        "sources": [{"alias": "x", "role": "primary", "sheet": "S", "header_row": 1}],
        "joins": [],
        "mappings": [{"target": "a", "source": "x.a"}],
    }


def test_save_then_get(api_client):
    r = api_client.post("/api/configs", json=_config())
    assert r.status_code == 200
    assert r.json()["name"] == "demo"

    r = api_client.get("/api/configs/demo")
    assert r.status_code == 200
    assert r.json()["name"] == "demo"


def test_duplicate_save_returns_409(api_client):
    api_client.post("/api/configs", json=_config())
    r = api_client.post("/api/configs", json=_config())
    assert r.status_code == 409
    body = r.json()["detail"]
    assert body["code"] == "ConfigExists"


def test_overwrite_query_param(api_client):
    api_client.post("/api/configs", json=_config())
    r = api_client.post("/api/configs?overwrite=true", json=_config())
    assert r.status_code == 200


def test_get_missing_returns_404(api_client):
    r = api_client.get("/api/configs/missing")
    assert r.status_code == 404


def test_list(api_client):
    api_client.post("/api/configs", json=_config("a"))
    api_client.post("/api/configs", json=_config("b"))
    r = api_client.get("/api/configs")
    assert r.status_code == 200
    assert r.json()["configs"] == ["a", "b"]


def test_delete(api_client):
    api_client.post("/api/configs", json=_config())
    r = api_client.delete("/api/configs/demo")
    assert r.status_code == 204
    assert api_client.get("/api/configs/demo").status_code == 404


def test_invalid_schema_returns_422(api_client):
    r = api_client.post("/api/configs", json={"name": "x", "bad": "field"})
    assert r.status_code == 422


def test_invalid_name_pattern_returns_422(api_client):
    r = api_client.post("/api/configs", json=_config(name="bad/name"))
    assert r.status_code == 422


def test_response_has_request_id_header(api_client):
    r = api_client.post("/api/configs", json=_config())
    assert "x-request-id" in {k.lower() for k in r.headers.keys()}
