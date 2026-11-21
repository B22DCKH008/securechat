"""Nạp + làm sạch + chia tập dữ liệu URL (PhiUSIIL, PhishVN). Quy ước nội bộ: y = 1 là ĐỘC HẠI, y = 0 là hợp lệ."""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from securechat_ml.data.splits import assert_disjoint, class_balance, group_split
from securechat_ml.features.url import domain_of_url

_SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]*://")

URL_COL_CANDIDATES = ["url", "URL", "full_url", "Url", "link"]
LABEL_COL_CANDIDATES = ["label", "Label", "is_phishing", "phishing", "class", "y", "target"]
TIER_COL_CANDIDATES = ["label_confidence", "confidence_tier", "confidence", "tier", "label_tier"]
SPLIT_COL_CANDIDATES = ["split", "Split", "dataset_split", "subset"]

_POS = {"1", "true", "phishing", "phish", "malicious", "bad", "scam"}
_NEG = {"0", "false", "legitimate", "legit", "benign", "good", "safe"}


def url_key(u: str) -> str:
    s = str(u).strip().lower()
    s = _SCHEME.sub("", s)
    if s.startswith("www."):
        s = s[4:]
    return s.rstrip("/")


def _pick(df: pd.DataFrame, given: str | None, candidates: list[str], what: str, required: bool = True) -> str | None:
    if given:
        if given not in df.columns:
            raise ValueError(f"Cột {what}='{given}' không có. Các cột hiện có: {list(df.columns)}")
        return given
    for c in candidates:
        if c in df.columns:
            return c
    if required:
        raise ValueError(f"Không tự dò được cột {what}. Điền vào configs/url.yaml. Các cột hiện có: {list(df.columns)}")
    return None


def _parse_label(v) -> int:
    s = str(v).strip().lower()
    if s in _POS:
        return 1
    if s in _NEG:
        return 0
    raise ValueError(f"Giá trị nhãn không nhận ra: {v!r}. Sửa phishvn.label_col hoặc ánh xạ trong data/urls.py")


def _tier(v) -> str:
    s = str(v).strip().lower()
    for t in ("gold", "silver", "bronze"):
        if t in s:
            return t
    return "unknown"


def load_phiusiil(path: Path | str, cfg: dict) -> pd.DataFrame:
    c = cfg["phiusiil"]
    df = pd.read_csv(path, usecols=[c["url_col"], c["label_col"]], encoding="utf-8-sig")
    out = pd.DataFrame({"url": df[c["url_col"]].astype(str), "y": (df[c["label_col"]] != c["legit_value"]).astype(int)})
    out["source"], out["tier"], out["split"] = "phiusiil", "", ""
    return out


def load_phishvn(path: Path | str, cfg: dict) -> pd.DataFrame:
    c = cfg["phishvn"]
    df = pd.read_csv(path, encoding="utf-8-sig")
    ucol = _pick(df, c.get("url_col"), URL_COL_CANDIDATES, "url")
    lcol = _pick(df, c.get("label_col"), LABEL_COL_CANDIDATES, "label")
    tcol = _pick(df, c.get("tier_col"), TIER_COL_CANDIDATES, "tier", required=False)
    scol = _pick(df, c.get("split_col"), SPLIT_COL_CANDIDATES, "split", required=False)
    out = pd.DataFrame({"url": df[ucol].astype(str), "y": df[lcol].map(_parse_label).astype(int)})
    out["source"] = "phishvn"
    out["tier"] = df[tcol].map(_tier) if tcol else "unknown"
    if scol:
        m = {"train": "train", "training": "train", "val": "val", "valid": "val", "validation": "val", "dev": "val", "test": "test"}
        sp = df[scol].astype(str).str.strip().str.lower().map(m)
        if sp.isna().any():
            raise ValueError(f"Giá trị split không nhận ra: {sorted(df[scol].astype(str).unique())[:8]}")
        out["split"] = sp
    else:
        out["split"] = ""
    return out


def clean_urls(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Khử trùng lặp theo khóa chuẩn hóa; bỏ URL bị gán cả hai nhãn; thêm cột domain."""
    n0 = len(df)
    df = df.copy()
    df["key"] = df["url"].map(url_key)
    nl = df.groupby("key")["y"].nunique()
    conflict = set(nl[nl > 1].index)
    df = df[~df["key"].isin(conflict)]
    df = df.drop_duplicates(subset="key", keep="first")
    df["domain"] = df["url"].map(domain_of_url)
    df = df[df["domain"] != ""]
    return df.reset_index(drop=True), {"input": n0, "kept": len(df), "conflicting_labels_dropped": len(conflict)}


def build_url_splits(phiusiil: pd.DataFrame | None, phishvn: pd.DataFrame | None, cfg: dict, seed: int) -> tuple[dict, dict]:
    manifest: dict = {"warnings": []}
    sets: dict[str, pd.DataFrame] = {}
    train_parts: list[pd.DataFrame] = []
    if phiusiil is not None:
        fr = cfg["split"]["phiusiil_fractions"]
        parts = group_split(phiusiil, "domain", "y", {"train": fr["train"], "val_in": fr["val_in"], "test_in": fr["test_in"]}, seed)
        train_parts.append(parts["train"])
        sets["val_in"], sets["test_in"] = parts["val_in"], parts["test_in"]
    if phishvn is not None:
        pv = cfg["phishvn"]
        if (phishvn["split"] == "").all():
            manifest["warnings"].append("PhishVN không có cột split: chia theo domain, KHÔNG theo thời gian. Nên dùng split gốc của tác giả.")
            parts = group_split(phishvn, "domain", "y", {"train": 0.6, "val": 0.2, "test": 0.2}, seed)
        else:
            parts = {k: phishvn[phishvn["split"] == k].copy() for k in ("train", "val", "test")}
        ev = pv.get("eval_tiers") or []
        trt = pv.get("train_tiers") or []
        def tier_ok(df, tiers):  # tier 'unknown' (không có cột tier) thì cho qua
            return df[df["tier"].isin(tiers) | (df["tier"] == "unknown")] if tiers else df
        sets["val_cross"] = tier_ok(parts["val"], ev)
        sets["test_cross"] = tier_ok(parts["test"], ev)
        if cfg.get("use_phishvn_train", True):
            train_parts.append(tier_ok(parts["train"], trt))
    if not train_parts:
        raise ValueError("Không có dữ liệu train (thiếu cả PhiUSIIL lẫn PhishVN).")
    train = pd.concat(train_parts, ignore_index=True)
    # chốt chặn leakage: bỏ khỏi train mọi domain đã xuất hiện ở val/test
    held = set().union(*[set(d["domain"]) for d in sets.values()]) if sets else set()
    before = len(train)
    train = train[~train["domain"].isin(held)].reset_index(drop=True)
    manifest["train_rows_dropped_domain_overlap"] = before - len(train)
    for name, d in sets.items():
        assert_disjoint({"train": train, name: d}, "domain")
    sets = {"train": train, **sets}
    manifest["sizes"] = {k: len(v) for k, v in sets.items()}
    manifest["class_balance"] = {k: class_balance(v, "y") for k, v in sets.items()}
    for k, v in sets.items():
        if len(v) and v["y"].nunique() < 2:
            manifest["warnings"].append(f"Tập '{k}' chỉ có một lớp: chỉ số P/R/AUC không tin cậy.")
    return sets, manifest
