"""Chia tập THEO NHÓM (domain / template) có phân tầng theo lớp, và các "chốt chặn" leakage."""
from __future__ import annotations

import numpy as np
import pandas as pd


def group_split(df: pd.DataFrame, group_col: str, label_col: str, fractions: dict[str, float], seed: int) -> dict[str, pd.DataFrame]:
    """Mỗi nhóm nằm trọn trong MỘT tập. Greedy theo 'nhu cầu tương đối còn lại' của từng lớp => tỉ lệ gần đúng, xác định theo seed.

    Cài đặt bằng numpy thuần (vòng lặp qua từng nhóm chỉ làm phép tính trên mảng nhỏ S x K). Bản dùng pandas Series trong
    vòng lặp mất ~1,6 ms/nhóm, tức vài phút với ~200 nghìn domain của PhiUSIIL; kết quả của hai bản GIỐNG HỆT
    (xem tests/test_group_split_equivalence.py).
    """
    names = list(fractions)
    assert abs(sum(fractions.values()) - 1.0) < 1e-9, "fractions phải cộng bằng 1"
    classes = sorted(df[label_col].unique())
    cnt = pd.crosstab(df[group_col], df[label_col]).reindex(columns=classes, fill_value=0)
    counts = cnt.to_numpy(dtype=float)                       # G x K: số dòng mỗi lớp trong từng nhóm
    total = counts.sum(axis=0)                               # K
    target = np.stack([total * fractions[s] for s in names])  # S x K: chỉ tiêu mỗi tập, mỗi lớp
    zero_target = target == 0
    safe_target = np.where(zero_target, 1.0, target)
    eps = np.array([1e-9 * fractions[s] for s in names])     # phá hòa theo thứ tự khai báo
    assigned = np.zeros_like(target)
    rng = np.random.default_rng(seed)
    choice = np.zeros(len(cnt), dtype=np.int64)
    for idx in rng.permutation(len(cnt)):
        c = counts[idx]
        need = np.maximum(target - assigned, 0.0)
        rel = np.where(zero_target, 0.0, need / safe_target)
        score = (np.minimum(c, need) * rel).sum(axis=1) + eps
        best = int(np.argmax(score))                         # hòa => lấy tập khai báo trước (như bản cũ)
        choice[idx] = best
        assigned[best] += c
    where = pd.Series(np.array(names, dtype=object)[choice], index=cnt.index)
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
