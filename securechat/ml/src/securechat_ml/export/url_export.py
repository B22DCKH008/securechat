"""Xuất model URL: LR -> JSON (TS tự tính), HGB/RF -> ONNX (onnxruntime-web). Kèm fixtures cho parity đặc trưng + xác suất."""
from __future__ import annotations

import math

import joblib
import numpy as np

from securechat_ml.config import Paths, write_json
from securechat_ml.export.fixtures_input import URL_INPUTS
from securechat_ml.features.url import FEATURE_NAMES, extract_features, spec_constants
from securechat_ml.models.url.train import featurize


def _r(x: float) -> float:
    return float(f"{x:.9g}")


def lr_to_json(pipe, names: list[str], threshold: float, version: str) -> dict:
    sc, clf = pipe.named_steps["scale"], pipe.named_steps["clf"]
    return {
        "schema": "securechat.url-lr/1", "modelVersion": version, "featureNames": names, "threshold": threshold,
        "mean": [_r(x) for x in sc.mean_], "scale": [_r(x) for x in sc.scale_],
        "coef": [_r(x) for x in clf.coef_[0]], "intercept": _r(clf.intercept_[0]),
    }


def predict_lr_json(m: dict, x: list[float]) -> float:
    z = m["intercept"] + sum(c * ((v - mu) / sd) for c, v, mu, sd in zip(m["coef"], x, m["mean"], m["scale"]))
    return 1 / (1 + math.exp(-z))


def export_url(paths: Paths) -> dict:
    adir = paths.artifacts_dir("url")
    b = joblib.load(adir / "models.joblib")
    names, version = b["featureNames"], b["modelVersion"]
    spec = {**spec_constants(), "usedFeatureNames": names, "modelVersion": version, "selected": b.get("selected")}
    write_json(adir / "url_spec.json", spec, indent=1)

    report: dict = {"selected": b.get("selected"), "models": {}}
    fx_urls = featurize(URL_INPUTS, names)
    fixtures = {
        "note": "TS phải khớp: allFeatures (|diff|<=1e-9) rồi probabilities (LR: 1e-6, ONNX: 1e-4).",
        "urls": URL_INPUTS,
        "featureNamesAll": FEATURE_NAMES,
        "allFeatures": [extract_features(u) for u in URL_INPUTS],
        "usedFeatureNames": names,
        "probabilities": {},
    }
    for mname, rec in b["models"].items():
        model, thr = rec["model"], rec["threshold"]
        fixtures["probabilities"][mname] = {"threshold": thr, "values": [float(p) for p in model.predict_proba(fx_urls)[:, 1]]}
        entry: dict = {"threshold": thr}
        if mname == "lr":
            j = lr_to_json(model, names, thr, version)
            write_json(adir / "url_lr.json", j, indent=None)
            entry.update({"file": "url_lr.json", "bytes": (adir / "url_lr.json").stat().st_size, "runtime": "json+ts"})
        else:
            try:
                from skl2onnx import to_onnx
                from skl2onnx.common.data_types import FloatTensorType

                onx = to_onnx(model, initial_types=[("features", FloatTensorType([None, len(names)]))], options={id(model): {"zipmap": False}}, target_opset=17)
                p = adir / f"url_{mname}.onnx"
                p.write_bytes(onx.SerializeToString())
                entry.update({"file": p.name, "bytes": p.stat().st_size, "runtime": "onnxruntime-web (wasm)"})
            except Exception as e:  # không chặn các model khác
                entry.update({"error": f"{type(e).__name__}: {str(e)[:300]}"})
        report["models"][mname] = entry
    write_json(adir / "url_parity_fixtures.json", fixtures, indent=1)
    report["files"] = {"spec": "url_spec.json", "fixtures": "url_parity_fixtures.json"}
    write_json(adir / "url_export_report.json", report)
    return report


def onnx_predict(path, X: np.ndarray) -> np.ndarray:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    out = sess.run(None, {"features": X.astype(np.float32)})
    probs = out[1]
    if isinstance(probs, list):  # zipmap còn bật
        probs = np.array([[d[0], d[1]] for d in probs])
    return np.asarray(probs)[:, 1]
