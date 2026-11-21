"""CLI: python -m securechat_ml.cli [--demo] <lệnh>. Xem README để biết thứ tự chạy."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from securechat_ml.config import ML_ROOT, Paths, load_cfg, message_labels, write_json


def _p(x):
    print(json.dumps(x, ensure_ascii=False, indent=2, default=float))


def cmd_demo_data(a, paths: Paths):
    from securechat_ml.data.demo import make_demo_messages, make_demo_urls

    _p({"messages": make_demo_messages(paths.root), "urls": make_demo_urls(paths.root)})
    print("DEMO ONLY: số đo trên dữ liệu này không có ý nghĩa. Chạy các lệnh tiếp theo với --demo.")


def cmd_validate_messages(a, paths: Paths):
    from securechat_ml.data.messages import read_messages, validate_messages

    rep = validate_messages(read_messages(a.file), message_labels(paths))
    _p(rep)
    if rep["errors"]:
        sys.exit(1)


def cmd_prepare_messages(a, paths: Paths):
    from securechat_ml.data.messages import build_message_splits, read_messages, validate_messages

    cfg = load_cfg(paths, "message.yaml")
    labels = message_labels(paths)
    pool_p = paths.raw_dir / cfg["files"]["train_pool"]
    hand_p = paths.raw_dir / cfg["files"]["handlabeled"]
    if not pool_p.exists():
        sys.exit(f"Thiếu {pool_p}. Xem data/SYNTHETIC_SPEC.md để tạo dữ liệu, hoặc chạy `demo-data`.")
    pool = read_messages(pool_p, default_source="unknown")
    rep = validate_messages(pool, labels)
    if rep["errors"]:
        _p(rep)
        sys.exit("Dữ liệu train_pool có lỗi, sửa rồi chạy lại.")
    hand = None
    if hand_p.exists():
        hand = read_messages(hand_p, default_source="handlabeled")
        hrep = validate_messages(hand, labels)
        if hrep["errors"]:
            _p(hrep)
            sys.exit("Dữ liệu handlabeled có lỗi.")
    else:
        print(f"CẢNH BÁO: chưa có {hand_p} (test gán tay).")
    sets, man = build_message_splits(pool, hand, cfg, cfg["seed"], message_labels(paths))
    out = paths.splits_dir("messages")
    out.mkdir(parents=True, exist_ok=True)
    for name, df in sets.items():
        df.drop(columns=[c for c in ("norm",) if c in df.columns]).to_csv(out / f"{name}.csv", index=False, encoding="utf-8")
    man["input_validation"] = {"train_pool": rep}
    write_json(out / "split_manifest.json", man)
    _p({"sizes": man["sizes"], "class_balance": man["class_balance"], "warnings": man["warnings"]})


def cmd_prepare_urls(a, paths: Paths):
    from securechat_ml.data.urls import build_url_splits, clean_urls, load_phiusiil, load_phishvn

    cfg = load_cfg(paths, "url.yaml")
    pi_p, pv_p = paths.raw_dir / cfg["files"]["phiusiil"], paths.raw_dir / cfg["files"]["phishvn"]
    info = {}
    pi = pv = None
    if pi_p.exists():
        pi, info["phiusiil"] = clean_urls(load_phiusiil(pi_p, cfg))
    else:
        print(f"CẢNH BÁO: chưa có {pi_p}")
    if pv_p.exists():
        pv, info["phishvn"] = clean_urls(load_phishvn(pv_p, cfg))
    else:
        print(f"CẢNH BÁO: chưa có {pv_p} (sẽ không có test chéo miền)")
    sets, man = build_url_splits(pi, pv, cfg, cfg["seed"])
    man["cleaning"] = info
    out = paths.splits_dir("urls")
    out.mkdir(parents=True, exist_ok=True)
    for name, df in sets.items():
        df[["url", "y", "source", "tier", "domain"]].to_csv(out / f"{name}.csv", index=False, encoding="utf-8")
    write_json(out / "split_manifest.json", man)
    _p({"sizes": man["sizes"], "class_balance": man["class_balance"], "warnings": man["warnings"], "cleaning": info})


def cmd_train_message(a, paths):
    from securechat_ml.models.message.train import train_message

    r = train_message(paths)
    _p({k: r[k] for k in ("modelVersion", "threshold", "vocab_size", "evaluated_on", "quality_bar", "warnings")})
    ev = "test" if "test" in r["model"] else "val"
    _p({"model_risky_vs_benign": r["model"][ev]["risky_vs_benign"], "rules_nac0": r["rules_baseline_nac0"].get(ev, {}).get("risky_vs_benign")})


def cmd_train_url(a, paths):
    from securechat_ml.models.url.train import train_url

    r = train_url(paths)
    _p({"modelVersion": r["modelVersion"], "validation_set": r["validation_set"], "primary_test": r["primary_test"], "selected_model": r["selected_model"],
        "per_model": {m: {"meets_bar": v["meets_bar_on_primary_test"], "primary": {k: v["sets"][r["primary_test"]][k] for k in ("precision", "recall", "fpr", "pr_auc")}} for m, v in r["models"].items()}})


def cmd_sweep_message(a, paths):
    from securechat_ml.models.message.sweep import sweep_message

    _p(sweep_message(paths))


def cmd_export_message(a, paths):
    from securechat_ml.export.message_json import export_message

    _p(export_message(paths))


def cmd_export_url(a, paths):
    from securechat_ml.export.url_export import export_url

    _p(export_url(paths))


def cmd_parity(a, paths):
    from securechat_ml.export.parity import run_parity

    r = run_parity(paths)
    _p(r)
    if not r["ok"]:
        sys.exit("PARITY FAIL")


def cmd_demo_all(a, paths):
    """Chạy cả đường ống trên dữ liệu demo (thay cho `make demo`, chạy được trên Windows)."""
    dp = Paths(paths.root, demo=True)
    for fn in (cmd_demo_data, cmd_prepare_messages, cmd_train_message, cmd_prepare_urls, cmd_train_url, cmd_export_message, cmd_export_url, cmd_parity):
        print(f"\n===== {fn.__name__.removeprefix('cmd_')} =====")
        fn(a, dp)


def cmd_demo_clean(a, paths):
    """Xóa đầu ra demo (thay cho `make demo-clean`)."""
    import shutil

    root = Path(paths.root)
    for rel in ("data/demo", "data/splits/demo", "models/demo_artifacts", "reports/demo"):
        shutil.rmtree(root / rel, ignore_errors=True)
    (root / "data/demo").mkdir(parents=True, exist_ok=True)
    (root / "data/demo/.gitkeep").touch()
    print("Đã xóa đầu ra demo.")


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):  # Windows: tránh lỗi in tiếng Việt khi stdout không phải UTF-8
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(prog="securechat-ml")
    ap.add_argument("--demo", action="store_true", help="dùng dữ liệu/thư mục demo (số đo vô nghĩa)")
    ap.add_argument("--root", default=str(ML_ROOT))
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in [("demo-data", cmd_demo_data), ("prepare-messages", cmd_prepare_messages), ("prepare-urls", cmd_prepare_urls),
                     ("train-message", cmd_train_message), ("train-url", cmd_train_url), ("sweep-message", cmd_sweep_message),
                     ("export-message", cmd_export_message), ("export-url", cmd_export_url), ("parity", cmd_parity),
                     ("demo-all", cmd_demo_all), ("demo-clean", cmd_demo_clean)]:
        sub.add_parser(name).set_defaults(fn=fn)
    v = sub.add_parser("validate-messages")
    v.add_argument("--file", required=True)
    v.set_defaults(fn=cmd_validate_messages)
    a = ap.parse_args(argv)
    a.fn(a, Paths(a.root, demo=a.demo))


if __name__ == "__main__":
    main()
