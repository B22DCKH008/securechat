"""Chuyển bộ SMS tiếng Việt công khai sang định dạng train_pool.

Ví dụ:
    python scripts/import_vi_sms.py \
        --src data/raw/vietnamese_sms_dataset/full_dataset.csv \
        --out data/raw/messages_vi_sms.csv

Ghi ra:
    <out>                                   text,label,source,group,lang  (source=real)
    reports/vi_sms_import.json              thống kê (số tin bị loại, số tin theo nhãn/luật)
    data/interim/vi_sms_review.csv          mẫu phân tầng theo luật để kiểm tra bằng mắt (không commit)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from securechat_ml.data import vi_sms  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="full_dataset.csv của bộ SMS")
    ap.add_argument("--out", default=str(ROOT / "data/raw/messages_vi_sms.csv"))
    ap.add_argument("--overrides", default=None, help="CSV message_id,label để sửa nhãn luật gán sai")
    ap.add_argument("--report", default=str(ROOT / "reports/vi_sms_import.json"))
    ap.add_argument("--review", default=str(ROOT / "data/interim/vi_sms_review.csv"))
    ap.add_argument("--per-rule", type=int, default=25, help="số tin mỗi (nhãn, luật) trong file review")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    df = pd.read_csv(a.src, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    ov = None
    if a.overrides:
        o = pd.read_csv(a.overrides, dtype=str, keep_default_na=False, encoding="utf-8-sig")
        ov = dict(zip(o["message_id"].str.strip(), o["label"].str.strip().str.lower()))
    d, rep = vi_sms.import_sms(df, overrides=ov, seed=a.seed)

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    vi_sms.to_pool(d).to_csv(out, index=False, encoding="utf-8")
    Path(a.report).parent.mkdir(parents=True, exist_ok=True)
    Path(a.report).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    vi_sms.review_sample(d, per_rule=a.per_rule, seed=a.seed).to_csv(a.review, index=False, encoding="utf-8-sig")
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    print(f"-> {out}\n-> {a.report}\n-> {a.review}")


if __name__ == "__main__":
    main()
