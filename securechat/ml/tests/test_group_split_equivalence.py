"""group_split (bản numpy) phải cho kết quả GIỐNG HỆT bản tham chiếu dùng pandas Series, và đủ nhanh với số nhóm lớn."""
import time

import numpy as np
import pandas as pd
import pytest

from securechat_ml.data.splits import group_split


def _reference_group_split(df, group_col, label_col, fractions, seed):
    """Bản gốc (chậm) giữ nguyên làm chuẩn so sánh. KHÔNG sửa hàm này."""
    names = list(fractions)
    classes = sorted(df[label_col].unique())
    cnt = pd.crosstab(df[group_col], df[label_col]).reindex(columns=classes, fill_value=0)
    total = cnt.sum(axis=0).astype(float)
    target = {s: total * fractions[s] for s in names}
    assigned = {s: pd.Series(0.0, index=classes) for s in names}
    rng = np.random.default_rng(seed)
    where = {}
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


def _make(n_rows, n_groups, classes, seed, skew=False):
    rng = np.random.default_rng(seed)
    p = None
    if skew:  # vài nhóm rất lớn + nhiều nhóm nhỏ, giống domain thật
        w = rng.pareto(1.2, n_groups) + 1
        p = w / w.sum()
    g = rng.choice(n_groups, n_rows, p=p)
    y = rng.choice(classes, n_rows)
    return pd.DataFrame({"g": [f"d{i}.com" for i in g], "y": y, "v": np.arange(n_rows)})


@pytest.mark.parametrize(
    "fr",
    [{"train": 0.8, "val_in": 0.1, "test_in": 0.1}, {"train": 0.6, "val": 0.2, "test": 0.2}, {"train": 0.7, "val": 0.3}],
)
@pytest.mark.parametrize("classes", [[0, 1], [0, 1, 2], [1]])
@pytest.mark.parametrize("seed", [0, 1, 42])
def test_same_assignment_as_reference(fr, classes, seed):
    df = _make(3000, 700, classes, seed, skew=(seed == 1))
    new = group_split(df, "g", "y", fr, seed)
    ref = _reference_group_split(df, "g", "y", fr, seed)
    assert list(new) == list(ref)
    for s in fr:
        assert new[s]["v"].tolist() == ref[s]["v"].tolist(), f"khác nhau ở tập {s}"


def test_class_missing_from_some_groups_and_tiny_input():
    df = pd.DataFrame({"g": ["a", "a", "b", "c"], "y": [0, 1, 0, 0]})
    fr = {"train": 0.5, "val": 0.5}
    new = group_split(df, "g", "y", fr, 7)
    ref = _reference_group_split(df, "g", "y", fr, 7)
    for s in fr:
        assert new[s]["g"].tolist() == ref[s]["g"].tolist()


def test_fast_with_many_groups():
    """Bản cũ mất ~1,6 ms/nhóm (30 nghìn nhóm ~ 50 s); bản mới phải dưới vài giây. Ngưỡng 15 s rất rộng để khỏi lỗi vặt."""
    df = _make(40_000, 30_000, [0, 1], 3)
    t = time.perf_counter()
    out = group_split(df, "g", "y", {"train": 0.8, "val_in": 0.1, "test_in": 0.1}, 42)
    assert time.perf_counter() - t < 15
    assert sum(len(v) for v in out.values()) == len(df)
