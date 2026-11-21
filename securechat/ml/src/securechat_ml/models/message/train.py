"""Train + đánh giá model tin nhắn: Nấc 0 (rules) và Nấc 1 (TF-IDF char+word + Logistic Regression)."""
from __future__ import annotations

import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from securechat_ml.config import Paths, load_cfg, load_yaml, message_labels, risky_labels, sha256_file, sha256_obj, write_json
from securechat_ml.evaluation.metrics import binary_report, bootstrap_ci, multiclass_report, threshold_for_precision
from securechat_ml.features.text import FEATURIZER_SPEC_VERSION, make_analyzer
from securechat_ml.models.message.rules import compile_rules, predict_rules


def read_split(paths: Paths, name: str) -> pd.DataFrame | None:
    p = paths.splits_dir("messages") / f"{name}.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    if "hard" in df:
        df["hard"] = pd.to_numeric(df["hard"], errors="coerce").fillna(0).astype(int)
    return df


def fit_vectorizer_and_model(train_texts, train_y, fcfg: dict, mcfg: dict, seed: int, max_features: int | None = None):
    vec = TfidfVectorizer(
        analyzer=make_analyzer(fcfg),
        sublinear_tf=bool(fcfg["sublinear_tf"]),
        min_df=int(fcfg["min_df"]),
        max_features=max_features or fcfg["max_features"],
        norm="l2",
        smooth_idf=True,
        dtype=np.float64,
    )
    X = vec.fit_transform(train_texts)  # CHỈ fit trên train (AI7)
    clf = LogisticRegression(C=mcfg["C"], class_weight=mcfg["class_weight"], max_iter=mcfg["max_iter"], random_state=seed)
    clf.fit(X, train_y)
    return vec, clf


def risky_score(vec, clf, texts: list[str], risky: list[str]) -> tuple[np.ndarray, np.ndarray]:
    P = clf.predict_proba(vec.transform(texts))
    cls = list(clf.classes_)
    idx = [cls.index(c) for c in risky if c in cls]
    return P[:, idx].sum(axis=1), P


def evaluate_sets(vec, clf, sets: dict[str, pd.DataFrame], thr: float, labels, risky, n_boot: int, seed: int) -> dict:
    out = {}
    for name, df in sets.items():
        if df is None or len(df) == 0:
            continue
        texts = df["text"].tolist()
        score, P = risky_score(vec, clf, texts, risky)
        y = df["label"].isin(risky).astype(int).to_numpy()
        pred_label = []
        cls = list(clf.classes_)
        for i, s in enumerate(score):
            if s >= thr:  # cảnh báo: chọn nhãn rủi ro có xác suất cao nhất
                best = max((c for c in risky if c in cls), key=lambda c: P[i, cls.index(c)])
                pred_label.append(best)
            else:
                pred_label.append("benign")
        out[name] = {
            "risky_vs_benign": binary_report(y, score, thr),
            "ci95": bootstrap_ci(y, score, thr, n=n_boot, seed=seed),
            "multiclass": multiclass_report(df["label"].tolist(), pred_label, labels),
        }
    return out


def evaluate_rules(sets: dict[str, pd.DataFrame], compiled, labels, risky, strip: bool) -> dict:
    out = {}
    for name, df in sets.items():
        if df is None or len(df) == 0:
            continue
        pred = [predict_rules(t, compiled, strip) for t in df["text"]]
        y = df["label"].isin(risky).astype(int).to_numpy()
        score = np.array([0.0 if p == "benign" else 1.0 for p in pred])
        out[name] = {"risky_vs_benign": binary_report(y, score, 0.5), "multiclass": multiclass_report(df["label"].tolist(), pred, labels)}
    return out


def train_message(paths: Paths) -> dict:
    cfg = load_cfg(paths, "message.yaml")
    seed = cfg["seed"]
    labels, risky = message_labels(paths), risky_labels(paths)
    sets = {n: read_split(paths, n) for n in ("train", "val", "test", "test_hard")}
    if sets["train"] is None or sets["val"] is None:
        raise SystemExit("Chưa có data/splits: chạy `prepare-messages` trước.")
    tr, va = sets["train"], sets["val"]
    t0 = time.perf_counter()
    vec, clf = fit_vectorizer_and_model(tr["text"].tolist(), tr["label"].tolist(), cfg["featurizer"], cfg["model"], seed)
    fit_s = time.perf_counter() - t0

    # ---- chọn ngưỡng CHỈ trên validation ----
    sv, _ = risky_score(vec, clf, va["text"].tolist(), risky)
    yv = va["label"].isin(risky).astype(int).to_numpy()
    th = threshold_for_precision(yv, sv, cfg["threshold"]["target_precision"])
    thr = th["threshold"]

    n_boot = cfg["bootstrap"]["n"]
    eval_sets = {"val": va, "test": sets["test"], "test_hard": sets["test_hard"]}
    model_metrics = evaluate_sets(vec, clf, eval_sets, thr, labels, risky, n_boot, seed)
    compiled = compile_rules(load_yaml(paths.config("rules.yaml")))
    rules_metrics = evaluate_rules(eval_sets, compiled, labels, risky, cfg["featurizer"]["strip_diacritics"])

    manifest_path = paths.splits_dir("messages") / "split_manifest.json"
    data_hash = sha256_file(paths.splits_dir("messages") / "train.csv")
    spec_hash = sha256_obj({"featurizer": cfg["featurizer"], "model": cfg["model"], "spec": FEATURIZER_SPEC_VERSION})
    model_version = f"msg-{spec_hash[:6]}-{data_hash[:6]}"

    adir = paths.artifacts_dir("message")
    adir.mkdir(parents=True, exist_ok=True)
    joblib.dump({"vectorizer": vec, "classifier": clf, "featurizer": cfg["featurizer"], "modelVersion": model_version}, adir / "model.joblib")
    write_json(adir / "threshold.json", {"threshold": thr, "selected_on": "val", "target_precision": cfg["threshold"]["target_precision"], **th, "modelVersion": model_version})

    t = model_metrics.get("test") or model_metrics["val"]
    rb = t["risky_vs_benign"]
    target_p, target_r = cfg["threshold"]["target_precision"], cfg["threshold"]["target_recall"]
    meets = (rb["precision"] >= target_p) and (rb["recall"] >= target_r) if not (np.isnan(rb["precision"]) or np.isnan(rb["recall"])) else False
    result = {
        "modelVersion": model_version,
        "task": "message risky-vs-benign",
        "threshold": th,
        "vocab_size": len(vec.vocabulary_),
        "fit_seconds": round(fit_s, 3),
        "evaluated_on": "test" if sets["test"] is not None else "val (KHÔNG có test gán tay)",
        "quality_bar": {"precision>=": target_p, "recall>=": target_r, "met_on_evaluated_set": bool(meets)},
        "model": model_metrics,
        "rules_baseline_nac0": rules_metrics,
        "warnings": (read_manifest(manifest_path) or {}).get("warnings", []),
        "note": "Nếu validation/test chứa dữ liệu tổng hợp thì số đo KHÔNG phản ánh chat thật.",
    }
    write_json(paths.reports_dir() / "message_metrics.json", result)
    return result


def read_manifest(p: Path):
    import json
    return json.load(open(p, encoding="utf-8")) if p.exists() else None
