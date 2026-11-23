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
    """Mỗi URL chỉ tính extract_features MỘT lần rồi chọn cột (bản cũ tính lại 26 lần/URL, chậm gấp ~26 lần)."""
    idx = [FEATURE_NAMES.index(n) for n in names]
    if not urls:
        return np.zeros((0, len(idx)), dtype=np.float64)
    return np.array([extract_features(u) for u in urls], dtype=np.float64)[:, idx]


def select_model(results: dict, order: list[str]) -> tuple[str | None, str | None]:
    """Chọn model CHỈ dựa trên VALIDATION: đơn giản nhất (theo thứ tự `order`) đạt ngưỡng trên validation.

    Trả (selected, val_selected). `val_selected` là model validation chọn. `selected` chỉ khác None khi model đó CŨNG đạt ngưỡng
    trên test chính (test dùng để XÁC NHẬN, không để chọn). None => bên FE dùng LR và ghi meetsBar=false (báo cáo trung thực).
    """
    val_selected = next((m for m in order if results[m]["meets_bar_on_validation"]), None)
    selected = val_selected if val_selected and results[val_selected]["meets_bar_on_primary_test"] else None
    return selected, val_selected


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
        def _meets(r):
            return bool(r["recall"] >= target_recall and r["fpr"] <= max_fpr) if not (np.isnan(r["recall"]) or np.isnan(r["fpr"])) else False

        results[mname] = {"fit_seconds": round(fit_s, 2), "threshold": th, "sets": per,
                          "meets_bar_on_validation": _meets(per[val_name]), "meets_bar_on_primary_test": _meets(per[primary_test])}
        fitted[mname] = {"model": model, "threshold": th["threshold"]}

    # chọn model theo VALIDATION (không dùng test để chọn); test chỉ xác nhận. Kích thước thật xác nhận ở bước export
    selected, val_selected = select_model(results, list(cfg["models"]))
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
        "validation_selected_model": val_selected,
        "selected_note": (
            "Chọn trên VALIDATION: model đơn giản nhất đạt ngưỡng; test chỉ để xác nhận. null = không model nào vừa đạt trên validation "
            "vừa được test xác nhận => FE dùng LR với meetsBar=false (báo cáo trung thực)."
        ),
        "models": results,
    }
    write_json(paths.reports_dir() / "url_metrics.json", out)
    return out
