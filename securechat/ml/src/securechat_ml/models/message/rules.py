"""Nấc 0: rule-based. Cùng bộ pattern (configs/rules.yaml) được xuất sang JSON cho TypeScript."""
from __future__ import annotations

import re

from securechat_ml.features.text import normalize_text


def compile_rules(rules_cfg: dict) -> list[dict]:
    out = []
    for r in rules_cfg["rules"]:
        out.append({"id": r["id"], "label": r["label"], "pattern": r["pattern"], "re": re.compile(r["pattern"])})
    return out


def match_rules(text: str, compiled: list[dict], strip_diacritics: bool = True) -> list[str]:
    s = normalize_text(text, strip_diacritics)
    return [r["id"] for r in compiled if r["re"].search(s)]


def predict_rules(text: str, compiled: list[dict], strip_diacritics: bool = True) -> str:
    ids = set(match_rules(text, compiled, strip_diacritics))
    labels = {r["label"] for r in compiled if r["id"] in ids}
    if "scam" in labels:
        return "scam"
    if "spam" in labels:
        return "spam"
    return "benign"


def export_rules_json(rules_cfg: dict) -> dict:
    return {"specVersion": 1, "normalization": "same as message featurizer (strip diacritics, urltoken, bignum)", "rules": [{"id": r["id"], "label": r["label"], "pattern": r["pattern"]} for r in rules_cfg["rules"]]}
