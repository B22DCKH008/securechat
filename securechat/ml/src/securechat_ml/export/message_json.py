"""Xuất model tin nhắn sang JSON (TF-IDF + LR) và bộ chạy tham chiếu bằng Python thuần (mô phỏng đúng việc TypeScript phải làm)."""
from __future__ import annotations

import math

import joblib

from securechat_ml.config import Paths, load_yaml, read_json, write_json
from securechat_ml.export.fixtures_input import MESSAGE_TEXTS
from securechat_ml.features.text import FEATURIZER_SPEC_VERSION, analyze, normalize_text, tfidf_sparse
from securechat_ml.models.message.rules import export_rules_json

SCHEMA = "securechat.message-model/1"


def _r(x: float) -> float:
    return float(f"{x:.8g}")


def build_model_dict(vec, clf, f: dict, version: str, threshold: float, risky: list[str]) -> dict:
    inv = [None] * len(vec.vocabulary_)
    for term, j in vec.vocabulary_.items():
        inv[int(j)] = term
    return {
        "schema": SCHEMA,
        "modelVersion": version,
        "labels": [str(c) for c in clf.classes_],
        "riskyLabels": list(risky),
        "threshold": threshold,
        "featurizer": {
            "specVersion": FEATURIZER_SPEC_VERSION,
            "stripDiacritics": bool(f["strip_diacritics"]),
            "charNgram": list(f["char_ngram"]),
            "wordNgram": list(f["word_ngram"]),
            "sublinearTf": bool(f["sublinear_tf"]),
        },
        "vocab": inv,
        "idf": [_r(x) for x in vec.idf_],
        "coef": [[_r(x) for x in row] for row in clf.coef_],
        "intercept": [_r(x) for x in clf.intercept_],
    }


def export_message(paths: Paths) -> dict:
    adir = paths.artifacts_dir("message")
    bundle = joblib.load(adir / "model.joblib")
    vec, clf, f = bundle["vectorizer"], bundle["classifier"], bundle["featurizer"]
    th = read_json(adir / "threshold.json")
    labels_cfg = load_yaml(paths.config("labels.yaml"))["message_model"]
    model = build_model_dict(vec, clf, f, bundle["modelVersion"], th["threshold"], labels_cfg["risky_labels"])
    out = adir / "message_model.json"
    write_json(out, model, indent=None)
    rules_out = adir / "message_rules.json"
    write_json(rules_out, export_rules_json(load_yaml(paths.config("rules.yaml"))), indent=2)
    fx = build_message_fixtures(model, bundle)
    write_json(adir / "message_parity_fixtures.json", fx, indent=1)
    return {"model_json": str(out), "bytes": out.stat().st_size, "vocab": len(model["vocab"]), "fixtures": str(adir / "message_parity_fixtures.json"), "rules": str(rules_out)}


def predict_message_json(model: dict, text: str) -> dict:
    """Tham chiếu cho TS: dùng ĐÚNG cấu trúc JSON đã xuất (không dùng sklearn)."""
    f = model["featurizer"]
    feats = analyze(text, char_ngram=tuple(f["charNgram"]), word_ngram=tuple(f["wordNgram"]), strip_diacritics=f["stripDiacritics"])
    vocab = model.get("_vocab_index")
    if vocab is None:
        vocab = {t: i for i, t in enumerate(model["vocab"])}
        model["_vocab_index"] = vocab
    vec = tfidf_sparse(feats, vocab, model["idf"], f["sublinearTf"])
    logits = []
    for row, b in zip(model["coef"], model["intercept"]):
        logits.append(b + sum(v * row[j] for j, v in vec.items()))
    if len(logits) == 1:
        p1 = 1 / (1 + math.exp(-logits[0]))
        probs = [1 - p1, p1]
    else:
        m = max(logits)
        e = [math.exp(z - m) for z in logits]
        s = sum(e)
        probs = [x / s for x in e]
    risky = sum(p for lb, p in zip(model["labels"], probs) if lb in model["riskyLabels"])
    return {"probs": probs, "riskyScore": risky, "warn": risky >= model["threshold"]}


def build_message_fixtures(model: dict, bundle: dict) -> dict:
    f = model["featurizer"]
    strip = f["stripDiacritics"]
    vec, clf = bundle["vectorizer"], bundle["classifier"]
    normalize, analyze_cases, predict = [], [], []
    for t in MESSAGE_TEXTS:
        normalize.append({"input": t, "expected": normalize_text(t, strip)})
        feats = analyze(t, char_ngram=tuple(f["charNgram"]), word_ngram=tuple(f["wordNgram"]), strip_diacritics=strip)
        analyze_cases.append({"input": t, "features": feats})
        P = clf.predict_proba(vec.transform([t]))[0]
        risky = float(sum(p for lb, p in zip(clf.classes_, P) if lb in model["riskyLabels"]))
        predict.append({"input": t, "probs": [float(x) for x in P], "riskyScore": risky, "warn": risky >= model["threshold"]})
    return {
        "note": "TS phải khớp: normalize (chuỗi giống hệt), analyze (danh sách feature giống hệt), predict (|diff| <= 1e-5).",
        "tolerance": 1e-5,
        "modelVersion": model["modelVersion"],
        "labels": model["labels"],
        "normalize": normalize,
        "analyze": analyze_cases,
        "predict": predict,
    }
