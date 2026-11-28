"""Lần 2 của model tin nhắn: tiêu chí đạt không bị kéo theo mục tiêu chọn ngưỡng, báo cáo validation theo nguồn,
và script gộp pool không cho tập test lọt vào train."""
import importlib.util
import json
import shutil
from pathlib import Path

import pandas as pd
import pytest
import yaml

from securechat_ml.config import ML_ROOT, Paths

ROOT = Path(__file__).resolve().parents[1]
LABELS = ["benign", "spam", "scam"]


def _load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_pool_builder_rejects_the_locked_test_file(tmp_path):
    mod = _load_script("build_message_pool")
    hand = tmp_path / "messages_handlabeled.csv"
    pd.DataFrame({"text": ["xin chao ban"], "label": ["benign"], "source": "handlabeled"}).to_csv(hand, index=False)
    with pytest.raises(SystemExit, match="TEST"):
        mod.build([hand], tmp_path / "pool.csv", LABELS, forbidden_names={"messages_handlabeled.csv"})
    assert not (tmp_path / "pool.csv").exists()


def test_pool_builder_rejects_rows_marked_handlabeled_even_under_another_name(tmp_path):
    mod = _load_script("build_message_pool")
    f = tmp_path / "copy.csv"
    pd.DataFrame({"text": ["xin chao ban"], "label": ["benign"], "source": "handlabeled"}).to_csv(f, index=False)
    with pytest.raises(SystemExit, match="handlabeled"):
        mod.build([f], tmp_path / "pool.csv", LABELS)


def test_pool_builder_reports_per_file_counts_and_unknown_source(tmp_path):
    mod = _load_script("build_message_pool")
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    pd.DataFrame({"text": ["xin chao ban", "toi di hoc"], "label": ["benign", "benign"], "source": "synthetic", "group": "g1"}).to_csv(a, index=False)
    pd.DataFrame({"text": ["nhan thuong ngay"], "label": ["scam"]}).to_csv(b, index=False)  # thiếu cột source
    rep = mod.build([a, b], tmp_path / "pool.csv", LABELS)
    assert rep["by_file"]["a.csv"] == {"rows": 2, "by_label": {"benign": 2}}
    assert rep["by_file"]["b.csv"]["rows"] == 1
    assert rep["rows"] == 3 and any("b.csv" in w and "source" in w for w in rep["warnings"])


def test_val_by_source_only_when_two_sources_and_both_classes():
    from securechat_ml.models.message.train import val_by_source

    risky = ["spam", "scam"]
    real_only_benign = pd.DataFrame({"text": list("abcd"), "label": ["benign"] * 4, "source": "real"})
    syn = pd.DataFrame({"text": list("efgh"), "label": ["benign", "spam", "scam", "benign"], "source": "synthetic"})
    out = val_by_source(pd.concat([real_only_benign, syn], ignore_index=True), risky)
    assert list(out) == ["val_synthetic"]  # nguồn real chỉ có benign => bỏ qua, không làm hỏng báo cáo
    assert val_by_source(syn, risky) == {}  # một nguồn => không tách


@pytest.fixture()
def demo_root_with_target(tmp_path):
    shutil.copytree(ML_ROOT / "configs", tmp_path / "configs")
    p = tmp_path / "configs" / "message.yaml"
    cfg = yaml.safe_load(p.read_text(encoding="utf-8"))
    cfg["threshold"]["target_precision"] = 0.99  # mục tiêu CHỌN ngưỡng rất cao
    p.write_text(yaml.safe_dump(cfg, allow_unicode=True), encoding="utf-8")
    return tmp_path


def test_quality_bar_does_not_follow_threshold_target(demo_root_with_target):
    """Đổi mục tiêu chọn ngưỡng (0.99) không được làm đổi tiêu chí đạt trên test (0.90 / 0.80)."""
    from securechat_ml.cli import cmd_demo_data, cmd_prepare_messages
    from securechat_ml.models.message.train import train_message

    paths = Paths(demo_root_with_target, demo=True)
    cmd_demo_data(None, paths)
    cmd_prepare_messages(None, paths)
    m = train_message(paths)
    assert m["quality_bar"]["precision>="] == 0.90 and m["quality_bar"]["recall>="] == 0.80
    assert m["quality_bar"]["threshold_selection_target_precision"] == 0.99
    th = json.loads((paths.artifacts_dir("message") / "threshold.json").read_text(encoding="utf-8"))
    assert th["target_precision"] == 0.99 and th["selected_on"] == "val"

    # eval-message đo lại model đã lưu: phải ra ĐÚNG số của lần train vừa rồi (cùng model, cùng ngưỡng)
    from securechat_ml.models.message.train import evaluate_saved

    e = evaluate_saved(paths)
    assert e["modelVersion"] == m["modelVersion"] and e["threshold"] == m["threshold"]["threshold"]
    for k in ("precision", "recall", "fpr"):
        assert e["sets"]["test"][k] == m["model"]["test"]["risky_vs_benign"][k]


def test_committed_quality_bar_is_the_preregistered_one():
    """Chốt chặn: tiêu chí đạt được khai báo trước khi xem kết quả (27/11/2026: 0.90 / 0.80). Đổi file này là đổi luật chơi."""
    cfg = yaml.safe_load((ML_ROOT / "configs" / "message.yaml").read_text(encoding="utf-8"))
    assert cfg["threshold"]["quality_precision"] == 0.90
    assert cfg["threshold"]["target_recall"] == 0.80


def test_test_without_sender_context_drops_only_noted_rows():
    from securechat_ml.models.message.train import (
        CONTEXT_NOTE,
        test_without_sender_context,
    )

    te = pd.DataFrame({"text": list("abcde"), "label": ["benign", "scam", "spam", "benign", "scam"],
                       "note": ["", CONTEXT_NOTE, "", f"{CONTEXT_NOTE}; xem lại", "người quen nhờ bình chọn"]})
    out = test_without_sender_context(te)["test_excl_sender_context"]
    assert list(out["text"]) == ["a", "c", "e"]
    assert test_without_sender_context(te.drop(columns="note")) == {}
    assert test_without_sender_context(te.assign(note="")) == {}
    assert test_without_sender_context(None) == {}
