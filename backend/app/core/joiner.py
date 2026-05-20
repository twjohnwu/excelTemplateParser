"""Multi-source join engine.

Takes a dict of alias -> DataFrame and a list of join rules. Each rule is
`{ "left": "alias.col", "right": "alias.col", "type": "left"|"inner" }`.
Applies rules in order, starting from the primary alias (first encountered
on the LHS).

Raises JoinKeyMissing when a referenced column doesn't exist.
"""

from __future__ import annotations

from typing import Mapping

import pandas as pd

from .exceptions import JoinKeyMissing


def join(sources: Mapping[str, pd.DataFrame], joins: list[dict]) -> pd.DataFrame:
    """Apply a sequence of joins to `sources`, returning the merged DataFrame.

    Output column names are prefixed with their alias (e.g. ``orders.單號``)
    so downstream mappings can reference them unambiguously.

    Sources not referenced by any join rule are treated as "single-row constant
    sources" and broadcast onto every row of the merged result. A source with 0
    or >1 rows that isn't joined is an error.
    """
    if not sources:
        raise JoinKeyMissing(
            user_message="沒有任何來源",
            tech_detail="sources dict is empty",
        )

    prefixed = {alias: _prefix(df, alias) for alias, df in sources.items()}
    connected: set[str] = set()
    merged: pd.DataFrame | None = None

    for rule in joins:
        left_alias, left_col = _split(rule["left"])
        right_alias, right_col = _split(rule["right"])
        how = rule.get("type", "left")

        left_full = f"{left_alias}.{left_col}"
        right_full = f"{right_alias}.{right_col}"

        if merged is None:
            if left_alias not in prefixed:
                raise JoinKeyMissing(
                    user_message=f"來源「{left_alias}」不存在",
                    tech_detail=f"available: {list(prefixed)}",
                    join_spec=rule,
                )
            merged = prefixed[left_alias]
            connected.add(left_alias)

        if left_full not in merged.columns:
            raise JoinKeyMissing(
                user_message=f"來源「{left_alias}」缺少欄位『{left_col}』",
                tech_detail=f"available columns: {list(merged.columns)}",
                join_spec=rule,
            )
        if right_alias not in prefixed:
            raise JoinKeyMissing(
                user_message=f"來源「{right_alias}」不存在",
                tech_detail=f"available: {list(prefixed)}",
                join_spec=rule,
            )
        right_df = prefixed[right_alias]
        if right_full not in right_df.columns:
            raise JoinKeyMissing(
                user_message=f"來源「{right_alias}」缺少欄位『{right_col}』",
                tech_detail=f"available columns: {list(right_df.columns)}",
                join_spec=rule,
            )

        merged = merged.merge(right_df, how=how, left_on=left_full, right_on=right_full)
        connected.add(left_alias)
        connected.add(right_alias)

    if merged is None:
        # No join rules at all — pick the first source as the base.
        first_alias = next(iter(sources))
        merged = prefixed[first_alias]
        connected.add(first_alias)

    # Broadcast unjoined sources as constant columns.
    for alias, df in sources.items():
        if alias in connected:
            continue
        if len(df) == 0:
            raise JoinKeyMissing(
                user_message=f"來源「{alias}」沒有資料列，無法作為固定單欄來源",
                tech_detail=f"unjoined source {alias} has 0 rows",
            )
        if len(df) > 1:
            raise JoinKeyMissing(
                user_message=(
                    f"來源「{alias}」有 {len(df)} 列，無法作為固定單欄來源廣播；"
                    f"若需逐列對應請新增 join 規則"
                ),
                tech_detail=f"unjoined source {alias} has {len(df)} rows, expected 1",
            )
        row = df.iloc[0]
        for col in df.columns:
            merged[f"{alias}.{col}"] = row[col]

    return merged


def _prefix(df: pd.DataFrame, alias: str) -> pd.DataFrame:
    return df.rename(columns={col: f"{alias}.{col}" for col in df.columns})


def _split(qualified: str) -> tuple[str, str]:
    if "." not in qualified:
        raise JoinKeyMissing(
            user_message=f"欄位『{qualified}』格式錯誤（需為 alias.column）",
            tech_detail="missing '.' in qualified name",
        )
    alias, _, col = qualified.partition(".")
    return alias, col
