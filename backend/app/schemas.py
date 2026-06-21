"""Pydantic schemas: ConfigSchema (the json a user authors in ConfigBuilder)
plus runtime DTOs used by the API and worker.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NAME_PATTERN = re.compile(r"^[\w一-鿿぀-ヿ\- ]{1,80}$", re.UNICODE)

Operator = Literal[">=", "<=", "==", "!=", "contains", "regex", "in"]
SourceRole = Literal["primary", "lookup"]
JoinType = Literal["left", "inner", "outer", "right"]
JobStatus = Literal["pending", "running", "done", "failed", "cancelled"]
SubtaskStatus = Literal["pending", "running", "done", "failed"]


class TargetTemplate(BaseModel):
    sheet: str
    header_row: int = Field(ge=1)
    preserve_styles: bool = True
    columns: list[str] = Field(min_length=1)
    # Filename used when the config was last saved — shown as a hint in BatchRunner.
    sample_filename: str | None = None


class SourceSpec(BaseModel):
    alias: str = Field(min_length=1)
    role: SourceRole
    sheet: str
    header_row: int = Field(ge=1)
    sample_filename: str | None = None


class JoinRule(BaseModel):
    left: str
    right: str
    type: JoinType = "left"

    @field_validator("left", "right")
    @classmethod
    def _qualified(cls, v: str) -> str:
        if "." not in v or v.startswith(".") or v.endswith("."):
            raise ValueError(f"必須為 alias.column 格式，收到 {v!r}")
        return v


class Condition(BaseModel):
    field: str
    op: Operator
    value: Any

    @field_validator("field")
    @classmethod
    def _qualified(cls, v: str) -> str:
        if "." not in v:
            raise ValueError(f"條件欄位必須為 alias.column 格式，收到 {v!r}")
        return v


class SourceCell(BaseModel):
    """Absolute cell reference into a source's xlsx sheet, bypassing the header
    abstraction. The sheet is the one defined on the matching SourceSpec.
    """

    alias: str = Field(min_length=1)
    address: str = Field(pattern=r"^[A-Z]+[1-9]\d*$")


class Mapping(BaseModel):
    target: str = Field(min_length=1)
    source: str | None = None
    literal: Any = None
    source_cell: SourceCell | None = None
    conditions: list[Condition] = Field(default_factory=list)
    default: Any = ""

    @field_validator("source")
    @classmethod
    def _qualified(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if "." not in v:
            raise ValueError(f"映射來源必須為 alias.column 格式，收到 {v!r}")
        return v

    @model_validator(mode="after")
    def _exactly_one_value_source(self) -> "Mapping":
        set_count = sum(
            x is not None for x in (self.source, self.literal, self.source_cell)
        )
        if set_count == 0:
            raise ValueError(
                f"mapping {self.target!r} 必須指定 source、source_cell 或 literal 其中一個"
            )
        if set_count > 1:
            raise ValueError(
                f"mapping {self.target!r} 的 source / source_cell / literal 只能擇一"
            )
        return self


class ConfigSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: str = "1.0"
    name: str
    target_template: TargetTemplate
    sources: list[SourceSpec] = Field(min_length=1)
    joins: list[JoinRule] = Field(default_factory=list)
    mappings: list[Mapping] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not NAME_PATTERN.match(v):
            raise ValueError("專案名稱僅可含中英文 / 數字 / 底線 / 連字號 / 空格，長度 1–80")
        return v

    @model_validator(mode="after")
    def _validate_relationships(self) -> "ConfigSchema":
        aliases = {s.alias for s in self.sources}
        if len({s.alias for s in self.sources}) != len(self.sources):
            raise ValueError("sources 中 alias 不可重複")
        primaries = [s for s in self.sources if s.role == "primary"]
        if not primaries:
            raise ValueError("至少需要一個 role=primary 的 source")

        for j in self.joins:
            for side in (j.left, j.right):
                alias = side.split(".", 1)[0]
                if alias not in aliases:
                    raise ValueError(f"join 引用了不存在的 source alias: {alias}")

        for m in self.mappings:
            if m.source is not None:
                alias = m.source.split(".", 1)[0]
                if alias not in aliases:
                    raise ValueError(f"mapping.source 引用了不存在的 alias: {alias}")
            if m.source_cell is not None and m.source_cell.alias not in aliases:
                raise ValueError(
                    f"mapping.source_cell 引用了不存在的 alias: {m.source_cell.alias}"
                )
            for c in m.conditions:
                a = c.field.split(".", 1)[0]
                if a not in aliases:
                    raise ValueError(f"condition.field 引用了不存在的 alias: {a}")

        return self

    @property
    def primary_alias(self) -> str:
        return next(s.alias for s in self.sources if s.role == "primary")

    @property
    def lookup_aliases(self) -> list[str]:
        return [s.alias for s in self.sources if s.role == "lookup"]


# ---------- Runtime DTOs ----------

class SubtaskState(BaseModel):
    source_file: str
    status: SubtaskStatus = "pending"
    duration_ms: int | None = None
    user_message: str | None = None
    tech_detail: str | None = None


class JobState(BaseModel):
    """Persisted in /data/jobs/{id}/state.json AND mirrored to Redis."""

    job_id: str
    config_name: str | None = None
    status: JobStatus = "pending"
    created_at: str
    download_started_at: str | None = None
    subtasks: dict[str, SubtaskState] = Field(default_factory=dict)
    cancel_requested: bool = False

    @property
    def total(self) -> int:
        return len(self.subtasks)

    @property
    def done(self) -> int:
        return sum(1 for s in self.subtasks.values() if s.status == "done")

    @property
    def failed(self) -> int:
        return sum(1 for s in self.subtasks.values() if s.status == "failed")


class JobSnapshot(BaseModel):
    """Public-facing summary returned by `GET /api/jobs/{id}`."""

    job_id: str
    status: JobStatus
    total: int
    done: int
    failed: int
    eta_seconds: int | None = None
    error: str | None = None
    config_name: str | None = None
