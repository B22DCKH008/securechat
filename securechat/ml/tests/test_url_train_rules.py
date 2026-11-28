"""featurize (tính 1 lần/URL), quy tắc chọn model theo VALIDATION, và val_tiers chỉ nới cho validation."""
import numpy as np
import pandas as pd

from securechat_ml.data.urls import build_url_splits
from securechat_ml.features.url import FEATURE_NAMES, extract_features
from securechat_ml.models.url.train import featurize, select_model

URLS = [
    "https://www.vietcombank-xacthuc.top/login?id=1&x=%20",
    "http://192.168.1.10:8080/a/b/c.php",
    "nhantienquoctej13.vercel.app",
    "https://sub.a.b.example.co.uk/path/to/page.html#frag",
    "http://user@evil.com/",
    "ftp://x.y/z",
    "https://xn--80ak6aa92e.com",
    "",
]


def _featurize_reference(urls, names):
    """Bản gốc (chậm, tính lại 26 lần/URL) làm chuẩn so sánh. KHÔNG sửa hàm này."""
    idx = [FEATURE_NAMES.index(n) for n in names]
    return np.array([[extract_features(u)[i] for i in idx] for u in urls], dtype=np.float64)


def test_featurize_identical_to_reference_all_and_subset():
    for names in (list(FEATURE_NAMES), [n for n in FEATURE_NAMES if n != "has_www"], [FEATURE_NAMES[3], FEATURE_NAMES[0]]):
        new = featurize(URLS, names)
        assert new.shape == (len(URLS), len(names))
        assert np.array_equal(new, _featurize_reference(URLS, names))


def test_featurize_empty_has_two_dims():
    assert featurize([], list(FEATURE_NAMES)).shape == (0, len(FEATURE_NAMES))


def _res(val, test):
    return {"meets_bar_on_validation": val, "meets_bar_on_primary_test": test}


def test_select_model_uses_validation_not_test():
    order = ["lr", "gbdt", "rf"]
    # lr đạt trên test nhưng KHÔNG đạt trên validation; gbdt đạt validation => chọn theo validation (gbdt), không theo test (lr)
    r = {"lr": _res(False, True), "gbdt": _res(True, True), "rf": _res(True, True)}
    assert select_model(r, order) == ("gbdt", "gbdt")


def test_select_model_simplest_that_meets_validation():
    r = {"lr": _res(True, True), "gbdt": _res(True, True), "rf": _res(True, True)}
    assert select_model(r, ["lr", "gbdt", "rf"]) == ("lr", "lr")


def test_select_model_requires_test_confirmation():
    r = {"lr": _res(True, False), "gbdt": _res(True, True)}
    assert select_model(r, ["lr", "gbdt"]) == (None, "lr")  # validation chọn lr nhưng test không xác nhận => None (không đổi sang gbdt nhờ test)


def test_select_model_none_when_validation_has_no_winner():
    r = {"lr": _res(False, True), "gbdt": _res(False, True)}
    assert select_model(r, ["lr", "gbdt"]) == (None, None)


def _pv():
    rows = []
    for sp in ("train", "val", "test"):
        for tier in ("gold", "silver", "bronze"):
            for y in (0, 1):
                if y == 0 and tier == "bronze":
                    continue  # bronze chỉ có phishing
                for i in range(3):
                    d = f"{sp}-{tier}-{y}-{i}.com"
                    rows.append({"url": d, "y": y, "source": "phishvn", "tier": tier, "split": sp, "domain": d})
    return pd.DataFrame(rows)


def _cfg(val_tiers):
    return {"phishvn": {"eval_tiers": ["gold", "silver"], "val_tiers": val_tiers, "train_tiers": ["gold", "silver"]}, "use_phishvn_train": True,
            "split": {"phiusiil_fractions": {"train": 0.8, "val_in": 0.1, "test_in": 0.1}}}


def test_val_tiers_default_keeps_validation_equal_to_eval_tiers():
    sets, _ = build_url_splits(None, _pv(), _cfg(None), 0)
    assert set(sets["val_cross"]["tier"]) == {"gold", "silver"}
    assert set(sets["test_cross"]["tier"]) == {"gold", "silver"}


def test_val_tiers_widens_only_validation():
    sets, _ = build_url_splits(None, _pv(), _cfg(["gold", "silver", "bronze"]), 0)
    assert "bronze" in set(sets["val_cross"]["tier"])
    assert set(sets["test_cross"]["tier"]) == {"gold", "silver"}  # test KHÔNG bao giờ có bronze
    assert set(sets["train"]["tier"]) <= {"gold", "silver"}
