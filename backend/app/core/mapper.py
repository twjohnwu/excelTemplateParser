"""Apply mapping rules (with optional conditions and defaults) to a joined DataFrame.

Each mapping yields one column of the output. If conditions are present,
they are AND-ed: when any fails the default value (or empty string) is used.

Supported operators: >=, <=, ==, !=, contains, regex, in
Regex evaluation has a per-cell timeout to prevent ReDoS.
"""

from __future__ import annotations

import re
import signal
from contextlib import contextmanager
from typing import Any

import pandas as pd

from .exceptions import MappingError, RegexTimeout

REGEX_TIMEOUT_SECONDS = 5


def apply(
    df: pd.DataFrame,
    mappings: list[dict],
    target_columns: list[str],
    pinned_cells: dict[int, Any] | None = None,
) -> pd.DataFrame:
    """Build the output DataFrame column-by-column from `mappings`.

    Output columns are the union of `target_columns` and every mapping target —
    `target_columns` order is preserved, then any mapping target not already
    listed is appended (so user-added mappings whose target isn't in the
    config's `target_template.columns` still appear in the output).

    Targets listed in `target_columns` without a matching mapping are filled
    with empty strings.

    `pinned_cells` is `{mapping_index: value}` of source_cell values resolved
    by the worker (mapper itself doesn't open xlsx files).
    """
    seen = set(target_columns)
    effective = list(target_columns)
    for m in mappings:
        target = m.get("target")
        if target and target not in seen:
            effective.append(target)
            seen.add(target)

    out: dict[str, list] = {}
    by_target: dict[str, tuple[int, dict]] = {m["target"]: (i, m) for i, m in enumerate(mappings)}
    pinned = pinned_cells or {}

    for target in effective:
        if target not in by_target:
            out[target] = [""] * len(df)
            continue
        idx, m = by_target[target]
        out[target] = _apply_one(df, m, pinned.get(idx))

    return pd.DataFrame(out, columns=effective)


def _apply_one(df: pd.DataFrame, mapping: dict, pinned_value: Any = None) -> list[Any]:
    source = mapping.get("source")
    literal = mapping.get("literal")
    source_cell = mapping.get("source_cell")
    default = mapping.get("default", "")
    conditions = mapping.get("conditions", [])
    n = len(df)

    # Literal mapping: every row gets the same value (subject to conditions).
    if literal is not None:
        return _broadcast_with_conditions(df, literal, default, conditions, n)

    # Cell-reference mapping: worker pre-resolved the value; broadcast it.
    if source_cell is not None:
        return _broadcast_with_conditions(df, pinned_value, default, conditions, n)

    if source is None:
        raise MappingError(
            user_message=f"映射『{mapping.get('target')}』缺少 source / source_cell / literal",
            tech_detail="source, source_cell, and literal are all absent",
            mapping=mapping,
        )

    if source not in df.columns:
        alias = source.split(".", 1)[0] if "." in source else source
        if not any(c.startswith(f"{alias}.") for c in df.columns):
            raise MappingError(
                user_message=(
                    f"來源「{alias}」的欄位未進入合併結果——它沒被任何 join 規則"
                    f"連到主來源，且不符合單列固定來源的條件"
                ),
                tech_detail=(
                    f"alias {alias!r} absent from merged df; "
                    f"available aliases: {sorted({c.split('.', 1)[0] for c in df.columns})}"
                ),
                mapping=mapping,
            )
        raise MappingError(
            user_message=f"映射來源欄位『{source}』不存在",
            tech_detail=f"available: {list(df.columns)}",
            mapping=mapping,
        )

    if not conditions:
        return df[source].tolist()

    result: list[Any] = []
    for idx in range(n):
        if all(_eval_condition(df.iloc[idx], cond) for cond in conditions):
            result.append(df[source].iloc[idx])
        else:
            result.append(default)
    return result


def _broadcast_with_conditions(
    df: pd.DataFrame, value: Any, default: Any, conditions: list[dict], n: int
) -> list[Any]:
    if not conditions:
        return [value] * n
    out: list[Any] = []
    for idx in range(n):
        if all(_eval_condition(df.iloc[idx], cond) for cond in conditions):
            out.append(value)
        else:
            out.append(default)
    return out


def _eval_condition(row: pd.Series, cond: dict) -> bool:
    field = cond["field"]
    op = cond["op"]
    expected = cond["value"]

    if field not in row.index:
        raise MappingError(
            user_message=f"條件欄位『{field}』不存在",
            tech_detail=f"available: {list(row.index)}",
            condition=cond,
        )

    actual = row[field]
    return _compare(actual, op, expected, cond)


def _compare(actual: Any, op: str, expected: Any, cond: dict) -> bool:
    if op == "==":
        return actual == expected
    if op == "!=":
        return actual != expected
    if op == ">=":
        return _numeric(actual, cond) >= _numeric(expected, cond)
    if op == "<=":
        return _numeric(actual, cond) <= _numeric(expected, cond)
    if op == "contains":
        return expected in (actual if isinstance(actual, str) else str(actual) if actual is not None else "")
    if op == "in":
        if not isinstance(expected, list):
            raise MappingError(
                user_message="`in` 運算子的值必須是陣列",
                tech_detail=f"got {type(expected).__name__}",
                condition=cond,
            )
        return actual in expected
    if op == "regex":
        haystack = actual if isinstance(actual, str) else "" if actual is None else str(actual)
        try:
            with _regex_timeout(REGEX_TIMEOUT_SECONDS):
                return re.search(expected, haystack) is not None
        except TimeoutError as exc:
            raise RegexTimeout(
                user_message=f"Regex 評估逾時（{REGEX_TIMEOUT_SECONDS} 秒）",
                tech_detail=f"pattern={expected!r}",
                condition=cond,
            ) from exc

    raise MappingError(
        user_message=f"未支援的運算子『{op}』",
        tech_detail=f"supported: >=, <=, ==, !=, contains, regex, in",
        condition=cond,
    )


def _numeric(value: Any, cond: dict) -> float:
    if value is None or value == "":
        return float("nan")
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise MappingError(
            user_message=f"無法將值轉為數字：{value!r}",
            tech_detail=str(exc),
            condition=cond,
        ) from exc


@contextmanager
def _regex_timeout(seconds: int):
    """SIGALRM-based timeout. Falls back to no-op on platforms without SIGALRM (Windows)."""
    if not hasattr(signal, "SIGALRM"):
        yield
        return

    def _handler(signum, frame):
        raise TimeoutError("regex timed out")

    previous = signal.signal(signal.SIGALRM, _handler)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)
