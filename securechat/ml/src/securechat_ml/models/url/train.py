"""Train + đánh giá model URL: LR / GradientBoosting / RandomForest trên đặc trưng từ chuỗi URL.

Nguyên tắc: chọn ngưỡng trên VALIDATION (ưu tiên val_cross của PhishVN), rồi báo cáo test ở NGƯỠNG ĐÓ.
Số "recall_at_fpr_oracle" (ngưỡng chọn ngay trên test) chỉ để tham khảo, không dùng làm kết luận.
"""
from __future__ import annotations

import time

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from securechat_ml.config import Paths, load_cfg, sha256_file, sha256_obj, write_json
from securechat_ml.evaluation.metrics import binary_report, bootstrap_ci, recall_at_fpr_oracle, threshold_for_fpr
from securechat_ml.features.url import FEATURE_NAMES, URL_SPEC_VERSION, extract_features


def used_features(cfg: dict) -> list[str]:
    ex = set(cfg["features"].get("exclude", []))
    return [n for n in FEATURE_NAMES if n not in ex]


def featurize(urls: list[str], names: list[str]) -> np.ndarray:
    idx = [FEATURE_NAMES.index(n) for n in names]
    return np.array([[extract_features(u)[i] for i in idx] for u in urls], dtype=np.float64)


def make_model(name: str, mcfg: dict, seed: int):
    if name == "lr":
        return Pipeline([("scale", StandardScaler()), ("clf", LogisticRegression(C=mcfg["C"], max_iter=mcfg["max_iter"], class_weight="balanced", random_state=seed))])
    if name == "gbdt":
        return GradientBoostingClassifier(n_estimators=mcfg["n_estimators"], max_depth=mcfg["max_depth"], learning_rate=mcfg["learning_rate"], subsample=mcfg["subsample"], random_state=seed)
    if name == "rf":
        return RandomForestClassifier(n_estimators=mcfg["n_estimators"], max_depth=mcfg["max_depth"], min_samples_leaf=mcfg["min_samples_leaf"], class_weight="balanced_subsample", n_jobs=2, random_state=seed)
    raise ValueError(f"model không hỗ trợ: {name}")


def read_url_split(paths: Paths, name: str) -> pd.DataFrame | None:
    p = paths.splits_dir("urls") / f"{name}.csv"
    return pd.read_csv(p, dtype={"url": str}, keep_default_na=False) if p.exists() else None


def train_url(paths: Paths) -> dict:
    cfg = load_cfg(paths, "url.yaml")
    seed = cfg["seed"]
    names = used_features(cfg)
    sets = {n: read_url_split(paths, n) for n in ("train", "val_in", "test_in", "val_cross", "test_cross")}
    if sets["train"] is None:
        raise SystemExit("Chưa có data/splits/urls: chạy `prepare-urls` trước.")
    X = {k: featurize(v["url"].tolist(), names) for k, v in sets.items() if v is not None and len(v)}
    Y = {k: sets[k]["y"].astype(int).to_numpy() for k in X}

    val_name = "val_cross" if "val_cross" in X and len(np.unique(Y["val_cross"])) == 2 else "val_in"
    primary_test = "test_cross" if "test_cross" in X else "test_in"
    max_fpr, target_recall = cfg["threshold"]["max_fpr"], cfg["threshold"]["target_recall"]
    n_boot = cfg["bootstrap"]["n"]

    data_hash = sha256_file(paths.splits_dir("urls") / "train.csv")
    spec_hash = sha256_obj({"features": names, "spec": URL_SPEC_VERSION, "models": cfg["models"]})
    version = f"url-{spec_hash[:6]}-{data_hash[:6]}"

    results, fitted = {}, {}
    for mname, mcfg in cfg["models"].items():
        t0 = time.perf_counter()
        model = make_model(mname, mcfg, seed).fit(X["train"], Y["train"])
        fit_s = time.perf_counter() - t0
        th = threshold_for_fpr(Y[val_name], model.predict_proba(X[val_name])[:, 1], max_fpr)
        per = {}
        for sname in X:
            if sname == "train":
                continue
            s = model.predict_proba(X[sname])[:, 1]
            per[sname] = {
                **binary_report(Y[sname], s, th["threshold"]),
                "ci95": bootstrap_ci(Y[sname], s, th["threshold"], n=n_boot, seed=seed),
                "recall_at_fpr_oracle": recall_at_fpr_oracle(Y[sname], s, max_fpr),
            }
        pt = per[primary_test]
        meets = bool(pt["recall"] >= target_recall and pt["fpr"] <= max_fpr) if not (np.isnan(pt["recall"]) or np.isnan(pt["fpr"])) else False
        results[mname] = {"fit_seconds": round(fit_s, 2), "threshold": th, "sets": per, "meets_bar_on_primary_test": meets}
        fitted[mname] = {"model": model, "threshold": th["threshold"]}

    # chọn model: đạt ngưỡng chất lượng + đơn giản nhất (thứ tự trong config); xác nhận kích thước thật ở bước export
    selected = next((m for m in cfg["models"] if results[m]["meets_bar_on_primary_test"]), None)
    adir = paths.artifacts_dir("url")
    adir.mkdir(parents=True, exist_ok=True)
    joblib.dump({"models": fitted, "featureNames": names, "modelVersion": version, "selected": selected}, adir / "models.joblib")
    out = {
        "modelVersion": version,
        "features_used": names,
        "validation_set": val_name,
        "primary_test": primary_test,
        "quality_bar": {"recall>=": target_recall, "fpr<=": max_fpr},
        "selected_model": selected,
        "selected_note": "Chọn model đơn giản nhất đạt ngưỡng; nếu null = chưa model nào đạt, báo cáo trung thực." if selected is None else "Đơn giản nhất trong các model đạt ngưỡng; so sánh thêm kích thước/latency ở bước export.",
        "models": results,
    }
    write_json(paths.reports_dir() / "url_metrics.json", out)
    return out
