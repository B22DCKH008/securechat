"""AI11: tối ưu có số đo = tỉa từ vựng (max_features). Báo cáo kích thước JSON, F1/precision/recall và độ trễ tham chiếu Python.

Lưu ý: độ trễ ở đây chỉ để so sánh tương đối giữa các cấu hình. Độ trễ thật (cold/warm, AI18) phải đo trong browser.
"""
from __future__ import annotations

import json
import statistics
import time

from securechat_ml.config import Paths, load_cfg, message_labels, risky_labels, write_json
from securechat_ml.evaluation.metrics import binary_report, threshold_for_precision
from securechat_ml.export.message_json import build_model_dict, predict_message_json
from securechat_ml.models.message.train import fit_vectorizer_and_model, read_split, risky_score


def sweep_message(paths: Paths) -> dict:
    cfg = load_cfg(paths, "message.yaml")
    risky = risky_labels(paths)
    tr, va = read_split(paths, "train"), read_split(paths, "val")
    te = read_split(paths, "test")
    evalset = te if te is not None and len(te) else va
    ev_name = "test" if evalset is te else "val"
    yv = va["label"].isin(risky).astype(int).to_numpy()
    ye = evalset["label"].isin(risky).astype(int).to_numpy()
    rows = []
    sample = evalset["text"].tolist()[:200]
    for k in cfg["sweep_max_features"]:
        vec, clf = fit_vectorizer_and_model(tr["text"].tolist(), tr["label"].tolist(), cfg["featurizer"], cfg["model"], cfg["seed"], max_features=k)
        sv, _ = risky_score(vec, clf, va["text"].tolist(), risky)
        th = threshold_for_precision(yv, sv, cfg["threshold"]["target_precision"])
        se, _ = risky_score(vec, clf, evalset["text"].tolist(), risky)
        rep = binary_report(ye, se, th["threshold"])
        md = build_model_dict(vec, clf, cfg["featurizer"], "sweep", th["threshold"], risky)
        size = len(json.dumps(md, separators=(",", ":")).encode("utf-8"))
        times = []
        for t in sample:
            t0 = time.perf_counter()
            predict_message_json(md, t)
            times.append((time.perf_counter() - t0) * 1000)
        rows.append({
            "max_features": k, "vocab": len(vec.vocabulary_), "json_bytes": size,
            "precision": rep["precision"], "recall": rep["recall"], "f1": rep["f1"], "pr_auc": rep["pr_auc"],
            "py_ref_latency_ms_p50": round(statistics.median(times), 3) if times else None,
        })
    out = {"evaluated_on": ev_name, "rows": rows, "note": "Tỉa vocab: chọn cấu hình nhỏ nhất vẫn đạt ngưỡng chất lượng. Kiểm parity lại sau khi chọn."}
    write_json(paths.reports_dir() / "optimization_message.json", out)
    return out
