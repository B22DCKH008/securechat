"""Gộp các file tin nhắn trong data/raw/ thành messages_train_pool.csv.

Ví dụ:
    python scripts/build_message_pool.py messages_vi_sms.csv messages_chat_synth.csv

Mỗi file đầu vào phải có cột text,label và nên có source (real/synthetic). Không sửa nội dung,
chỉ nối và kiểm tra cùng một bộ cột. Việc loại trùng/gom nhóm do `prepare-messages` làm.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from securechat_ml.config import Paths, load_cfg, message_labels  # noqa: E402
from securechat_ml.data.messages import read_messages, validate_messages  # noqa: E402

COLS = ["text", "label", "source", "group", "lang"]


def build(files: list[Path], out: Path, labels: list[str]) -> dict:
    parts = []
    for f in files:
        df = read_messages(f, default_source="unknown")
        rep = validate_messages(df, labels)
        if rep["errors"]:
            raise SystemExit(f"{f}: {rep['errors']}")
        parts.append(df[COLS])
    pool = pd.concat(parts, ignore_index=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    pool.to_csv(out, index=False, encoding="utf-8")
    return {
        "files": [str(f) for f in files],
        "rows": int(len(pool)),
        "by_source_label": {f"{s}/{l}": int(n) for (s, l), n in pool.groupby(["source", "label"]).size().items()},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", help="tên file trong data/raw/")
    ap.add_argument("--demo", action="store_true")
    a = ap.parse_args()
    paths = Paths(ROOT, demo=a.demo)
    cfg = load_cfg(paths, "message.yaml")
    rep = build([paths.raw_dir / f for f in a.files], paths.raw_dir / cfg["files"]["train_pool"], message_labels(paths))
    print(rep)


if __name__ == "__main__":
    main()
