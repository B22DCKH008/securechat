import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from securechat_ml.config import ML_ROOT, Paths
from securechat_ml.evaluation.metrics import binary_report, bootstrap_ci, recall_at_fpr_oracle, robust_threshold, threshold_for_fpr, threshold_for_precision


def test_threshold_for_precision_picks_max_recall_meeting_target():
    y = np.array([1, 1, 1, 0, 1, 0, 0, 0])
    s = np.array([0.95, 0.9, 0.8, 0.75, 0.6, 0.4, 0.3, 0.1])
    th = threshold_for_precision(y, s, 0.99)
    rep = binary_report(y, s, th["threshold"])
    assert th["reached"] and rep["precision"] == 1.0 and rep["recall"] == 0.75


def test_threshold_for_fpr_respects_limit():
    rng = np.random.default_rng(0)
    y = np.r_[np.ones(200), np.zeros(800)].astype(int)
    s = np.r_[rng.normal(1.5, 1, 200), rng.normal(0, 1, 800)]
    th = threshold_for_fpr(y, s, 0.01)
    assert binary_report(y, s, th["threshold"])["fpr"] <= 0.01
    assert recall_at_fpr_oracle(y, s, 0.01) == th["val_recall"]


def test_robust_threshold_sits_between_scores():
    s = np.array([0.2, 0.5, 0.9])
    t = robust_threshold(s, 0.9)
    assert 0.5 < t < 0.9 and np.all((s >= t) == (s >= 0.9))


def test_bootstrap_ci_contains_point_estimate():
    rng = np.random.default_rng(1)
    y = (rng.random(400) < 0.3).astype(int)
    s = np.clip(y * 0.6 + rng.normal(0.2, 0.2, 400), 0, 1)
    rep = binary_report(y, s, 0.5)
    ci = bootstrap_ci(y, s, 0.5, n=200, seed=0)
    assert ci["f1"][0] <= rep["f1"] <= ci["f1"][1]


@pytest.fixture(scope="module")
def demo_root(tmp_path_factory):
    root = tmp_path_factory.mktemp("mlroot")
    shutil.copytree(ML_ROOT / "configs", root / "configs")
    return root


def test_end_to_end_demo_pipeline(demo_root):
    """Chạy toàn bộ pipeline trên dữ liệu demo: prepare -> train -> export -> parity. (Số đo demo vô nghĩa; test kiểm đường ống.)"""
    from securechat_ml.cli import cmd_demo_data, cmd_prepare_messages, cmd_prepare_urls
    from securechat_ml.export.message_json import export_message
    from securechat_ml.export.parity import run_parity
    from securechat_ml.export.url_export import export_url
    from securechat_ml.models.message.train import train_message
    from securechat_ml.models.url.train import train_url

    paths = Paths(demo_root, demo=True)
    cmd_demo_data(None, paths)
    cmd_prepare_messages(None, paths)
    cmd_prepare_urls(None, paths)

    # chốt chặn leakage được ghi vào manifest và thực sự đúng
    import pandas as pd
    mdir = paths.splits_dir("messages")
    tr, va, te = (pd.read_csv(mdir / f"{n}.csv", dtype=str, keep_default_na=False) for n in ("train", "val", "test"))
    assert set(tr["group_id"]).isdisjoint(set(va["group_id"]))
    udir = paths.splits_dir("urls")
    utr = pd.read_csv(udir / "train.csv", dtype=str, keep_default_na=False)
    for n in ("val_in", "test_in", "val_cross", "test_cross"):
        d = pd.read_csv(udir / f"{n}.csv", dtype=str, keep_default_na=False)
        assert set(utr["domain"]).isdisjoint(set(d["domain"]))

    m = train_message(paths)
    assert m["threshold"]["threshold"] is not None
    # ngưỡng được chọn trên validation, không phải test
    assert json.loads((paths.artifacts_dir("message") / "threshold.json").read_text(encoding="utf-8"))["selected_on"] == "val"
    u = train_url(paths)
    assert u["validation_set"] in ("val_cross", "val_in")

    assert export_message(paths)["bytes"] > 0
    rep = export_url(paths)
    assert "lr" in rep["models"] and rep["models"]["lr"]["bytes"] > 0
    par = run_parity(paths)
    assert par["ok"], par

    # vocab chỉ chứa feature thấy ở TRAIN (vectorizer không fit trên val/test)
    mj = json.loads((paths.artifacts_dir("message") / "message_model.json").read_text(encoding="utf-8"))
    from securechat_ml.features.text import analyze
    seen = set()
    for t in tr["text"]:
        seen.update(analyze(t))
    assert set(mj["vocab"]) <= seen
