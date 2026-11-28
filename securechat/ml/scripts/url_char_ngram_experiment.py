"""THÍ NGHIỆM (không phải pipeline chính): URL -> TF-IDF n-gram ký tự + Logistic Regression.

Mục đích: kiểm xem biểu diễn n-gram ký tự có vượt rõ rệt 26 đặc trưng thủ công không (model hiện tại chỉ đạt recall 10-19% tại FPR<=1%
trên test_cross, và chỉ ~0.6-0.7 ngay cả trong miền PhiUSIIL). Dùng ĐÚNG giao thức của `train-url`:
  - ngưỡng chọn trên VALIDATION (val_cross) sao cho FPR <= max_fpr; test chỉ đo ở ngưỡng đó;
  - siêu tham số C chọn theo recall trên val_cross (KHÔNG nhìn test);
  - cùng bộ chỉ số, CI bootstrap, và số "oracle" chỉ để tham khảo.

Quy tắc quyết định, chốt TRƯỚC khi chạy: chỉ đáng port sang TypeScript nếu recall trên val_cross (tại FPR<=1% chọn trên chính val_cross)
>= 0.40, tức khoảng gấp đôi tốt nhất hiện tại (GBDT 0.193). Con số 0.40 là quy ước, không có cơ sở lý thuyết đặc biệt.

Chạy từ thư mục ml/:   python scripts/url_char_ngram_experiment.py
"""
from __future__ import annotations

import argparse
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from securechat_ml.evaluation.metrics import binary_report, bootstrap_ci, recall_at_fpr_oracle, threshold_for_fpr

_SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]*://")
NAMES = ("train", "val_in", "test_in", "val_cross", "test_cross")
GO_RULE_VAL_RECALL = 0.40


def norm(u: str, max_len: int) -> str:
    """Bỏ scheme và 'www.' đứng đầu (artefact thu thập), chữ thường, cắt độ dài, thêm cột mốc đầu/cuối."""
    s = _SCHEME.sub("", str(u).strip().lower())
    if s.startswith("www."):
        s = s[4:]
    return "^" + s[:max_len] + "$"


def load(dirp: Path) -> dict[str, pd.DataFrame]:
    out = {}
    for n in NAMES:
        p = dirp / f"{n}.csv"
        if p.exists():
            out[n] = pd.read_csv(p, dtype={"url": str}, keep_default_na=False)
    if "train" not in out:
        raise SystemExit(f"Chưa có {dirp}/train.csv: chạy `prepare-urls` trước.")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--splits", default="data/splits/urls")
    ap.add_argument("--ngram", default="3,5", help="khoảng n-gram ký tự, vd 3,5")
    ap.add_argument("--max-features", type=int, default=50_000, help="giới hạn từ vựng (ảnh hưởng kích thước file JSON gửi cho FE)")
    ap.add_argument("--max-len", type=int, default=200)
    ap.add_argument("--c-grid", default="0.3,1,3,10")
    ap.add_argument("--max-fpr", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--boot", type=int, default=300)
    a = ap.parse_args()

    sets = load(Path(a.splits))
    lo, hi = (int(x) for x in a.ngram.split(","))
    val_name = "val_cross" if "val_cross" in sets and sets["val_cross"]["y"].nunique() == 2 else "val_in"
    primary = "test_cross" if "test_cross" in sets else "test_in"
    text = {k: [norm(u, a.max_len) for u in v["url"]] for k, v in sets.items()}
    y = {k: v["y"].astype(int).to_numpy() for k, v in sets.items()}

    t0 = time.perf_counter()
    vec = TfidfVectorizer(analyzer="char", ngram_range=(lo, hi), lowercase=False, sublinear_tf=True, max_features=a.max_features, dtype=np.float32)
    X = {"train": vec.fit_transform(text["train"])}  # từ vựng/IDF chỉ học từ TRAIN
    for k in sets:
        if k != "train":
            X[k] = vec.transform(text[k])
    print(f"vectorize: {time.perf_counter() - t0:.1f}s | từ vựng {len(vec.vocabulary_):,} | n-gram {lo}-{hi} | validation={val_name} | test chính={primary}")

    best = None
    for C in (float(c) for c in a.c_grid.split(",")):
        t1 = time.perf_counter()
        clf = LogisticRegression(C=C, class_weight="balanced", solver="liblinear", max_iter=300, random_state=a.seed).fit(X["train"], y["train"])
        th = threshold_for_fpr(y[val_name], clf.predict_proba(X[val_name])[:, 1], a.max_fpr)
        print(f"  C={C:<5g} fit {time.perf_counter() - t1:5.1f}s  val recall@FPR<={a.max_fpr:.0%} = {th['val_recall']:.3f} (val FPR {th['val_fpr']:.4f})")
        if best is None or th["val_recall"] > best[0] + 1e-12:  # hòa => giữ C nhỏ hơn (đơn giản hơn)
            best = (th["val_recall"], C, clf, th)
    val_recall, C, clf, th = best
    print(f"\nChọn C={C:g} theo VALIDATION (recall {val_recall:.3f}). Ngưỡng {th['threshold']:.4f}\n")

    print(f"{'tập':10} {'n':>6} {'phish':>6} {'recall':>7} {'[CI95 recall]':>16} {'fpr':>6} {'prec':>6} {'pr_auc':>6} {'recall@fpr1%(oracle)':>21}")
    res = {}
    for k in sets:
        if k == "train":
            continue
        s = clf.predict_proba(X[k])[:, 1]
        r = binary_report(y[k], s, th["threshold"])
        ci = bootstrap_ci(y[k], s, th["threshold"], n=a.boot, seed=a.seed)
        orc = recall_at_fpr_oracle(y[k], s, a.max_fpr)
        res[k] = r
        lo_, hi_ = ci["recall"]
        print(f"{k:10} {r['n']:6d} {r['positives']:6d} {r['recall']:7.3f} [{lo_:5.3f},{hi_:5.3f}]  {r['fpr']:6.3f} {r['precision']:6.3f} {r['pr_auc']:6.3f} {orc:12.3f}")

    est_mb = len(vec.vocabulary_) * 30 / 1e6
    print(f"\nƯớc lượng kích thước JSON gửi FE: ~{est_mb:.1f} MB (từ vựng x ~30 byte/mục; thô)")
    go = val_recall >= GO_RULE_VAL_RECALL
    print(f"Quy tắc chốt trước: val recall {val_recall:.3f} {'>=' if go else '<'} {GO_RULE_VAL_RECALL:.2f} => {'ĐÁNG port sang TypeScript' if go else 'KHÔNG đủ lợi thế, giữ hướng báo cáo trung thực'}")


if __name__ == "__main__":
    main()
