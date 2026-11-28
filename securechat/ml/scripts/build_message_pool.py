"""Gộp các file tin nhắn trong data/raw/ thành messages_train_pool.csv.

Ví dụ:
    python scripts/build_message_pool.py messages_vi_sms.csv messages_chat_synth.csv

Mỗi file đầu vào phải có cột text,label và nên có source (real/synthetic). Không sửa nội dung,
chỉ nối và kiểm tra cùng một bộ cột. Việc loại trùng/gom nhóm do `prepare-messages` làm.

Có thể đưa nhiều file tổng hợp (mỗi lô sinh một file). Chạy lại lệnh này mỗi khi thêm hoặc đổi file.
Tập test gán tay (files.handlabeled trong configs/message.yaml) bị từ chối: không bao giờ được vào train pool.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from securechat_ml.config import Paths, load_cfg, message_labels  # noqa: E402
from securechat_ml.data.messages import read_messages, validate_messages  # noqa: E402

COLS = ["text", "label", "source", "group", "lang"]


def build(files: list[Path], out: Path, labels: list[str], forbidden_names: set[str] | frozenset[str] = frozenset()) -> dict:
    parts, by_file, warnings = [], {}, []
    for f in files:
        if f.name in forbidden_names:
            raise SystemExit(f"{f.name} là tập TEST gán tay, không được đưa vào train pool (chống rò rỉ).")
        df = read_messages(f, default_source="unknown")
        if (df["source"] == "handlabeled").any():
            raise SystemExit(f"{f}: có dòng source=handlabeled, đó là nhãn riêng của tập test; không đưa vào train pool.")
        rep = validate_messages(df, labels)
        if rep["errors"]:
            raise SystemExit(f"{f}: {rep['errors']}")
        n_unknown = int((df["source"] == "unknown").sum())
        if n_unknown:
            warnings.append(f"{f.name}: {n_unknown} dòng chưa có source (real/synthetic); dòng này không vào validation tổng hợp.")
        by_file[f.name] = {"rows": len(df), "by_label": {str(k): int(v) for k, v in df["label"].value_counts().items()}}
        parts.append(df[COLS])
    pool = pd.concat(parts, ignore_index=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    pool.to_csv(out, index=False, encoding="utf-8")
    return {
        "files": [str(f) for f in files],
        "by_file": by_file,
        "rows": int(len(pool)),
        "by_source_label": {f"{s}/{l}": int(n) for (s, l), n in pool.groupby(["source", "label"]).size().items()},
        "warnings": warnings,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", help="tên file trong data/raw/")
    ap.add_argument("--demo", action="store_true")
    a = ap.parse_args()
    paths = Paths(ROOT, demo=a.demo)
    cfg = load_cfg(paths, "message.yaml")
    rep = build(
        [paths.raw_dir / f for f in a.files],
        paths.raw_dir / cfg["files"]["train_pool"],
        message_labels(paths),
        forbidden_names={cfg["files"]["handlabeled"]},
    )
    print(json.dumps(rep, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
