import pytest
from pydantic import ValidationError

from app.schemas import ConfigSchema


def _minimal_config(**overrides):
    base = {
        "version": "1.0",
        "name": "demo",
        "target_template": {
            "sheet": "Sheet1",
            "header_row": 1,
            "preserve_styles": True,
            "columns": ["訂單編號", "客戶名稱"],
        },
        "sources": [
            {"alias": "orders", "role": "primary", "sheet": "訂單", "header_row": 1},
            {"alias": "customers", "role": "lookup", "sheet": "客戶", "header_row": 1},
        ],
        "joins": [
            {"left": "orders.客戶代號", "right": "customers.代號", "type": "left"},
        ],
        "mappings": [
            {"target": "訂單編號", "source": "orders.單號"},
            {"target": "客戶名稱", "source": "customers.名稱"},
        ],
    }
    base.update(overrides)
    return base


def test_valid_config():
    cfg = ConfigSchema.model_validate(_minimal_config())
    assert cfg.primary_alias == "orders"
    assert cfg.lookup_aliases == ["customers"]


def test_name_pattern_rejects_special_chars():
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(name="bad/name"))


def test_name_strip():
    cfg = ConfigSchema.model_validate(_minimal_config(name="  demo  "))
    assert cfg.name == "demo"


def test_duplicate_alias_rejected():
    bad = _minimal_config(sources=[
        {"alias": "x", "role": "primary", "sheet": "A", "header_row": 1},
        {"alias": "x", "role": "lookup", "sheet": "B", "header_row": 1},
    ])
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(bad)


def test_at_least_one_primary_required():
    bad = _minimal_config(sources=[
        {"alias": "x", "role": "lookup", "sheet": "A", "header_row": 1},
    ])
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(bad)


def test_join_unknown_alias_rejected():
    bad = _minimal_config(joins=[
        {"left": "orders.x", "right": "missing.y", "type": "left"},
    ])
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(bad)


def test_mapping_unknown_alias_rejected():
    bad = _minimal_config(mappings=[
        {"target": "x", "source": "missing.col"},
    ])
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(bad)


def test_condition_unqualified_field_rejected():
    bad = _minimal_config(mappings=[
        {
            "target": "x",
            "source": "orders.單號",
            "conditions": [{"field": "no_dot", "op": "==", "value": "v"}],
        },
    ])
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(bad)


def test_extra_fields_forbidden():
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(unexpected="x"))


def test_mapping_default_value_optional():
    cfg = ConfigSchema.model_validate(_minimal_config(mappings=[
        {"target": "x", "source": "orders.單號"},
    ]))
    assert cfg.mappings[0].default == ""


def test_mapping_literal_accepted():
    cfg = ConfigSchema.model_validate(_minimal_config(mappings=[
        {"target": "x", "literal": "fixed"},
    ]))
    assert cfg.mappings[0].literal == "fixed"
    assert cfg.mappings[0].source is None


def test_mapping_source_xor_literal():
    # Both present → reject
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(mappings=[
            {"target": "x", "source": "orders.單號", "literal": "fixed"},
        ]))
    # Neither present → reject
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(mappings=[
            {"target": "x"},
        ]))


def test_mapping_source_cell_accepted():
    cfg = ConfigSchema.model_validate(_minimal_config(mappings=[
        {"target": "x", "source_cell": {"alias": "orders", "address": "A3"}},
    ]))
    assert cfg.mappings[0].source_cell is not None
    assert cfg.mappings[0].source_cell.address == "A3"
    assert cfg.mappings[0].source is None
    assert cfg.mappings[0].literal is None


def test_mapping_source_cell_xor_others():
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(mappings=[
            {
                "target": "x",
                "source": "orders.單號",
                "source_cell": {"alias": "orders", "address": "A1"},
            },
        ]))
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(mappings=[
            {
                "target": "x",
                "literal": "fixed",
                "source_cell": {"alias": "orders", "address": "A1"},
            },
        ]))


def test_mapping_source_cell_address_pattern():
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(mappings=[
            {"target": "x", "source_cell": {"alias": "orders", "address": "3A"}},
        ]))
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(mappings=[
            {"target": "x", "source_cell": {"alias": "orders", "address": "A0"}},
        ]))


def test_mapping_source_cell_unknown_alias_rejected():
    with pytest.raises(ValidationError):
        ConfigSchema.model_validate(_minimal_config(mappings=[
            {"target": "x", "source_cell": {"alias": "ghost", "address": "A1"}},
        ]))
