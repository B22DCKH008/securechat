"""Parity phía Python (AI16): artifact đã xuất phải cho kết quả = model gốc. Phần TS dùng fixtures cùng thư mục."""
from __future__ import annotations

import joblib
import numpy as np
import pandas as pd

from securechat_ml.config import Paths, read_json, write_json
from securechat_ml.export.message_json import predict_message_json
from securechat_ml.export.url_export import onnx_predict, predict_lr_json
from securechat_ml.models.url.train import featurize


def run_parity(paths: Paths, sample: int = 500) -> dict:
    report: dict = {"ok": True, "message": None, "url": {}}
    # ---- message ----
    mdir = paths.artifacts_dir("message")
    if (mdir / "message_model.json").exists():
        mj = read_json(mdir / "message_model.json")
        b = joblib.load(mdir / "model.joblib")
        vec, clf = b["vectorizer"], b["classifier"]
        texts = list(read_json(mdir / "message_parity_fixtures.json")["analyze"][i]["input"] for i in range(len(read_json(mdir / "message_parity_fixtures.json")["analyze"])))
        p = paths.splits_dir("messages") / "test.csv"
        if p.exists():
            texts += pd.read_csv(p, dtype=str, keep_default_na=False)["text"].head(sample).tolist()
        maxdiff, agree = 0.0, 0
        for t in texts:
            ref = clf.predict_proba(vec.transform([t]))[0]
            got = predict_message_json(mj, t)["probs"]
            maxdiff = max(maxdiff, float(np.max(np.abs(ref - np.array(got)))))
            agree += int(int(np.argmax(ref)) == int(np.argmax(got)))
        ok = maxdiff <= 1e-5 and agree == len(texts)
        report["message"] = {"n": len(texts), "max_abs_prob_diff": maxdiff, "label_agreement": agree / len(texts), "ok": ok, "tolerance": 1e-5}
        report["ok"] &= ok
    # ---- url ----
    udir = paths.artifacts_dir("url")
    if (udir / "models.joblib").exists():
        b = joblib.load(udir / "models.joblib")
        names = b["featureNames"]
        urls = read_json(udir / "url_parity_fixtures.json")["urls"]
        p = paths.splits_dir("urls") / "test_cross.csv"
        if not p.exists():
            p = paths.splits_dir("urls") / "test_in.csv"
        if p.exists():
            urls = urls + pd.read_csv(p, dtype={"url": str}, keep_default_na=False)["url"].head(sample).tolist()
        X = featurize(urls, names)
        for mname, rec in b["models"].items():
            ref = rec["model"].predict_proba(X)[:, 1]
            thr = rec["threshold"]
            entry: dict = {}
            if mname == "lr":
                import json
                m = json.load(open(udir / "url_lr.json", encoding="utf-8"))
                got = np.array([predict_lr_json(m, list(x)) for x in X])
                tol = 1e-6
            else:
                f = udir / f"url_{mname}.onnx"
                if not f.exists():
                    report["url"][mname] = {"skipped": "chưa có file ONNX (xem url_export_report.json)"}
                    continue
                got = onnx_predict(f, X)
                tol = 1e-4
            diff = float(np.max(np.abs(ref - got)))
            agree = float(np.mean((ref >= thr) == (got >= thr)))
            entry = {"n": len(urls), "max_abs_prob_diff": diff, "decision_agreement": agree, "tolerance": tol, "ok": bool(diff <= tol and agree >= 0.999)}
            report["url"][mname] = entry
            report["ok"] &= entry["ok"]
    write_json(paths.reports_dir() / "parity_python.json", report)
    return report
