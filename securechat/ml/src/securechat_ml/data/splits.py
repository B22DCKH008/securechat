"""Chia tập THEO NHÓM (domain / template) có phân tầng theo lớp, và các "chốt chặn" leakage."""
from __future__ import annotations

import numpy as np
import pandas as pd


def group_split(df: pd.DataFrame, group_col: str, label_col: str, fractions: dict[str, float], seed: int) -> dict[str, pd.DataFrame]:
    """Mỗi nhóm nằm trọn trong MỘT tập. Greedy theo 'nhu cầu tương đối còn lại' của từng lớp => tỉ lệ gần đúng, xác định theo seed."""
    names = list(fractions)
    assert abs(sum(fractions.values()) - 1.0) < 1e-9, "fractions phải cộng bằng 1"
    classes = sorted(df[label_col].unique())
    cnt = pd.crosstab(df[group_col], df[label_col]).reindex(columns=classes, fill_value=0)
    total = cnt.sum(axis=0).astype(float)
    target = {s: total * fractions[s] for s in names}
    assigned = {s: pd.Series(0.0, index=classes) for s in names}
    rng = np.random.default_rng(seed)
    where: dict = {}
    for idx in rng.permutation(len(cnt)):
        g = cnt.index[idx]
        c = cnt.iloc[idx].astype(float)
        best, best_score = names[0], -1.0
        for s in names:
            need = (target[s] - assigned[s]).clip(lower=0)
            rel = need / target[s].replace(0, np.nan)
            rel = rel.fillna(0.0)
            score = float((np.minimum(c, need) * rel).sum()) + 1e-9 * fractions[s]
            if score > best_score:
                best, best_score = s, score
        where[g] = best
        assigned[best] = assigned[best] + c
    sp = df[group_col].map(where)
    return {s: df[sp == s].copy() for s in names}


def assert_disjoint(sets: dict[str, pd.DataFrame], col: str) -> None:
    """Lỗi nếu cùng một giá trị `col` (domain/group) xuất hiện ở hai tập khác nhau."""
    names = list(sets)
    vals = {n: set(sets[n][col].astype(str)) for n in names}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            inter = vals[a] & vals[b]
            if inter:
                raise AssertionError(f"LEAKAGE: {len(inter)} giá trị '{col}' trùng giữa '{a}' và '{b}' (vd: {sorted(inter)[:3]})")


def class_balance(df: pd.DataFrame, label_col: str) -> dict:
    return {str(k): int(v) for k, v in df[label_col].value_counts().items()}
