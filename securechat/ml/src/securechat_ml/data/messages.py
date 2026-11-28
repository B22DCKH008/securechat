"""Nạp, kiểm tra, khử trùng lặp, gom nhóm template và chia tập dữ liệu TIN NHẮN.

Quy tắc chống leakage (AI7):
  * Tin gần giống nhau (cosine >= near_dup_cosine) hoặc cùng cột `group` => cùng nhóm => luôn nằm CÙNG một tập.
  * Tin trong train bị loại nếu gần giống một tin trong TEST gán tay.
  * Dữ liệu `synthetic` không bao giờ vào test. Chỉ vào validation khi thiếu tin `real`, hoặc khi cấu hình
    `split.val_synthetic_fraction` > 0 (khi đó chọn theo NHÓM, validation = tin real + một phần nhóm tổng hợp).
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer

from securechat_ml.data.splits import class_balance, group_split
from securechat_ml.features.text import normalize_text

REQUIRED = ["text", "label"]
OPTIONAL_DEFAULTS = {"source": "unknown", "group": "", "hard": 0, "lang": "vi"}
VALID_SOURCES = {"real", "synthetic", "handlabeled", "unknown"}

_VI_WORDS = {"ban", "toi", "khong", "cua", "va", "la", "co", "da", "nhe", "oi", "minh", "anh", "chi", "em", "ngay", "hom", "nay", "tai", "khoan", "vui", "long", "xin", "chao"}


def read_messages(path: Path | str, default_source: str = "unknown") -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"{path}: thiếu cột {missing}. Cần tối thiểu {REQUIRED}; tùy chọn {list(OPTIONAL_DEFAULTS)}")
    for c, d in OPTIONAL_DEFAULTS.items():
        if c not in df.columns:
            df[c] = d
    df["source"] = df["source"].replace("", default_source)
    df["hard"] = pd.to_numeric(df["hard"], errors="coerce").fillna(0).astype(int)
    df["text"] = df["text"].astype(str)
    df["label"] = df["label"].astype(str).str.strip().str.lower()
    return df


def validate_messages(df: pd.DataFrame, labels: list[str]) -> dict:
    errors, warnings = [], []
    if df.empty:
        errors.append("File rỗng.")
        return {"errors": errors, "warnings": warnings}
    bad = sorted(set(df["label"]) - set(labels))
    if bad:
        errors.append(f"Nhãn không hợp lệ {bad}; cho phép {labels}")
    if (df["text"].str.strip() == "").any():
        errors.append(f"{int((df['text'].str.strip() == '').sum())} dòng text rỗng")
    bad_src = sorted(set(df["source"]) - VALID_SOURCES)
    if bad_src:
        errors.append(f"source không hợp lệ {bad_src}; cho phép {sorted(VALID_SOURCES)}")
    long_ = int((df["text"].str.len() > 1000).sum())
    if long_:
        warnings.append(f"{long_} tin dài > 1000 ký tự (chat thường ngắn)")
    norm = df["text"].map(normalize_text)
    dup = int(norm.duplicated().sum())
    if dup:
        warnings.append(f"{dup} tin trùng sau chuẩn hóa (sẽ bị loại khi prepare)")
    toks = norm.str.split(" ")
    vi_ratio = float(np.mean([bool(set(t) & _VI_WORDS) for t in toks]))
    if vi_ratio < 0.5:
        warnings.append(f"Chỉ {vi_ratio:.0%} tin có từ tiếng Việt phổ biến: kiểm tra có lẫn tiếng Anh/rác không")
    counts = class_balance(df, "label")
    for lb in labels:
        if counts.get(lb, 0) < 30:
            warnings.append(f"Nhãn '{lb}' chỉ có {counts.get(lb, 0)} mẫu (<30)")
    return {
        "errors": errors,
        "warnings": warnings,
        "n": int(len(df)),
        "label_counts": counts,
        "source_counts": class_balance(df, "source"),
        "vietnamese_ratio": round(vi_ratio, 3),
    }


def _find_root_factory(n: int):
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    return find, union


def _char_tfidf(texts: list[str]):
    v = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True, min_df=1)
    return v, v.fit_transform(texts)


def dedupe_and_group(df: pd.DataFrame, near_cos: float) -> tuple[pd.DataFrame, dict]:
    """Loại tin trùng (sau chuẩn hóa) / mâu thuẫn nhãn; gán group_id gộp theo `group` và theo gần-giống."""
    df = df.copy()
    n0 = len(df)
    df["norm"] = df["text"].map(normalize_text)
    nl = df.groupby("norm")["label"].nunique()
    conflict = set(nl[nl > 1].index)
    df = df[~df["norm"].isin(conflict)]
    df = df.drop_duplicates(subset="norm", keep="first").reset_index(drop=True)
    n = len(df)
    find, union = _find_root_factory(n)
    first: dict[str, int] = {}
    for i, g in enumerate(df["group"].tolist()):
        if g:
            if g in first:
                union(i, first[g])
            else:
                first[g] = i
    if n > 1:
        _, X = _char_tfidf(df["norm"].tolist())
        step = 500
        for s in range(0, n, step):
            S = (X[s : s + step] @ X.T).tocoo()
            keep = (S.data >= near_cos) & (S.row + s < S.col)
            for r, c in zip(S.row[keep] + s, S.col[keep]):
                union(int(r), int(c))
    df["group_id"] = [f"g{find(i)}" for i in range(n)]
    return df, {"input": n0, "kept": n, "conflicting_labels_dropped": len(conflict)}


def drop_near_dups_of(pool: pd.DataFrame, ref: pd.DataFrame, near_cos: float) -> tuple[pd.DataFrame, int]:
    """Bỏ khỏi `pool` các dòng gần giống bất kỳ dòng nào của `ref` (dùng để bảo vệ test)."""
    if pool.empty or ref.empty:
        return pool, 0
    ref_n = ref["text"].map(normalize_text).tolist()
    pool_n = pool["norm"].tolist() if "norm" in pool else pool["text"].map(normalize_text).tolist()
    v, X = _char_tfidf(pool_n + ref_n)
    Xp, Xr = X[: len(pool_n)], X[len(pool_n):]
    S = (Xp @ Xr.T).max(axis=1).toarray().ravel()
    mask = S >= near_cos
    return pool[~mask].reset_index(drop=True), int(mask.sum())


def _add_synthetic_to_validation(pool: pd.DataFrame, val: pd.DataFrame, cfg: dict, seed: int, manifest: dict) -> pd.DataFrame:
    """Thêm một phần NHÓM tin tổng hợp vào validation (khi `split.val_synthetic_fraction` > 0).

    Lý do: tin thật hiện chỉ là SMS, nên validation toàn SMS không cho thấy lỗi trên tin chat (lần 1: FPR 25% trên
    validation nhưng 55% trên test chat). Mỗi nhóm vẫn nằm trọn trong MỘT tập, nên train và val không chia sẻ nhóm.
    Phần tổng hợp của validation lạc quan hơn chat thật (cùng nguồn sinh với train), chỉ dùng để chọn ngưỡng.
    """
    vsf = float(cfg["split"].get("val_synthetic_fraction", 0.0) or 0.0)
    if vsf <= 0:
        return val
    if not 0 < vsf < 1:
        raise ValueError(f"split.val_synthetic_fraction phải nằm trong (0, 1), nhận {vsf}")
    syn = pool[(pool["source"] == "synthetic") & ~pool["group_id"].isin(set(val["group_id"]))]
    if syn["group_id"].nunique() < 2:
        manifest["warnings"].append("val_synthetic_fraction > 0 nhưng có dưới 2 nhóm tin tổng hợp: validation vẫn chỉ gồm tin real.")
        return val
    sp = group_split(syn, "group_id", "label", {"train": 1 - vsf, "val": vsf}, seed)
    manifest["validation_source"] = "real+synthetic"
    manifest["val_synthetic_fraction"] = vsf
    manifest["val_synthetic_rows"] = len(sp["val"])
    manifest["warnings"].append(
        "Validation gồm cả tin chat tổng hợp: phần này lạc quan hơn chat thật, chỉ dùng để chọn ngưỡng. Số đo cuối cùng vẫn là test gán tay."
    )
    return pd.concat([val, sp["val"]], ignore_index=True)


def build_message_splits(pool: pd.DataFrame, hand: pd.DataFrame | None, cfg: dict, seed: int, labels: list[str] | None = None) -> tuple[dict, dict]:
    labels = labels or ["benign", "spam", "scam"]
    manifest: dict = {"warnings": []}
    near = cfg["dedupe"]["near_dup_cosine"]
    pool, st = dedupe_and_group(pool, near)
    manifest["pool_clean"] = st
    sets: dict[str, pd.DataFrame] = {}
    if hand is not None and len(hand):
        hand = hand.copy()
        hand["norm"] = hand["text"].map(normalize_text)
        hand = hand.drop_duplicates(subset="norm").reset_index(drop=True)
        pool, dropped = drop_near_dups_of(pool, hand, near)
        manifest["train_rows_dropped_near_test"] = dropped
        hand["source"] = "handlabeled"
        sets["test"] = hand
        sets["test_hard"] = hand[hand["hard"] == 1]
        if len(sets["test_hard"]) == 0:
            manifest["warnings"].append("Không có tin đánh dấu hard=1 (không dấu/teencode/kiểu mới): nên bổ sung 'test khó'.")
    else:
        manifest["warnings"].append("KHÔNG có test gán tay: chưa thể báo cáo kết quả cuối (AI8). Chỉ có validation.")
    vf = cfg["split"]["val_fraction"]
    real = pool[pool["source"] == "real"]
    if len(real) >= cfg["split"]["val_min_real"]:
        rp = group_split(real, "group_id", "label", {"train": 1 - vf, "val": vf}, seed)
        val = rp["val"]
        manifest["validation_source"] = "real"
        val = _add_synthetic_to_validation(pool, val, cfg, seed, manifest)
    else:
        rp = group_split(pool, "group_id", "label", {"train": 1 - vf, "val": vf}, seed)
        val = rp["val"]
        manifest["validation_source"] = "mixed/synthetic"
        manifest["warnings"].append(
            f"Chỉ có {len(real)} tin real (<{cfg['split']['val_min_real']}): validation lẫn dữ liệu tổng hợp => ngưỡng chọn trên đó kém tin cậy."
        )
    train = pool[~pool["group_id"].isin(set(val["group_id"]))].reset_index(drop=True)
    sets = {"train": train, "val": val.reset_index(drop=True), **sets}
    manifest["sizes"] = {k: len(v) for k, v in sets.items()}
    manifest["class_balance"] = {k: class_balance(v, "label") for k, v in sets.items()}
    manifest["source_balance"] = {k: class_balance(v, "source") for k, v in sets.items()}
    for k in ("train", "val"):
        miss = set(labels) - set(sets[k]["label"])
        if miss:
            manifest["warnings"].append(f"Tập '{k}' thiếu nhãn {sorted(miss)}")
    return sets, manifest
