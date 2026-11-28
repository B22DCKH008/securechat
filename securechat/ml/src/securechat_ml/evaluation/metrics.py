"""Metrics (AI8) + chọn ngưỡng CHỈ trên validation (AI25) + bootstrap CI."""
from __future__ import annotations

import numpy as np
from sklearn.metrics import average_precision_score, confusion_matrix, precision_recall_curve, roc_curve


def binary_report(y: np.ndarray, score: np.ndarray, threshold: float) -> dict:
    y = np.asarray(y).astype(int)
    score = np.asarray(score, dtype=float)
    pred = (score >= threshold).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    prec = tp / (tp + fp) if tp + fp else float("nan")
    rec = tp / (tp + fn) if tp + fn else float("nan")
    f1 = 2 * prec * rec / (prec + rec) if (tp + fp and tp + fn and (prec + rec) > 0) else float("nan")
    fpr = fp / (fp + tn) if fp + tn else float("nan")
    ap = float(average_precision_score(y, score)) if 0 < y.sum() < len(y) else float("nan")
    return {
        "n": int(len(y)), "positives": int(y.sum()), "threshold": float(threshold),
        "precision": prec, "recall": rec, "f1": f1, "fpr": fpr, "pr_auc": ap,
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


def robust_threshold(score: np.ndarray, thr: float) -> float:
    """Dời ngưỡng về GIỮA điểm số được chọn và điểm số thấp liền kề: giữ nguyên quyết định trên tập chọn ngưỡng,
    nhưng không còn nằm đúng trên một giá trị điểm => bền với sai số float32/float64 giữa Python, ONNX và TypeScript."""
    score = np.asarray(score, dtype=float)
    if not np.isfinite(thr):
        return float(thr)
    lower = np.unique(score[score < thr])
    return float((thr + lower[-1]) / 2.0) if len(lower) else float(thr)


def threshold_for_precision(y: np.ndarray, score: np.ndarray, target_precision: float) -> dict:
    """Ngưỡng cho recall LỚN NHẤT với precision >= target. Không đạt được => trả ngưỡng precision cao nhất, reached=False."""
    y = np.asarray(y).astype(int)
    p, r, t = precision_recall_curve(y, score)
    p, r = p[:-1], r[:-1]  # khớp với t
    ok = p >= target_precision
    if ok.any():
        i = int(np.argmax(np.where(ok, r, -1)))
        return {"threshold": robust_threshold(score, float(t[i])), "reached": True, "val_precision": float(p[i]), "val_recall": float(r[i])}
    i = int(np.argmax(p))
    return {"threshold": robust_threshold(score, float(t[i])), "reached": False, "val_precision": float(p[i]), "val_recall": float(r[i])}


def threshold_for_fpr(y: np.ndarray, score: np.ndarray, max_fpr: float) -> dict:
    """Ngưỡng cho recall LỚN NHẤT với FPR <= max_fpr."""
    y = np.asarray(y).astype(int)
    fpr, tpr, t = roc_curve(y, score)
    ok = fpr <= max_fpr
    i = int(np.max(np.where(ok)[0])) if ok.any() else 0
    thr = float(t[i]) if np.isfinite(t[i]) else float(np.max(score) + 1e-9)
    thr = robust_threshold(score, thr)
    return {"threshold": thr, "reached": bool(ok.any()), "val_fpr": float(fpr[i]), "val_recall": float(tpr[i])}


def recall_at_fpr_oracle(y: np.ndarray, score: np.ndarray, max_fpr: float) -> float:
    """CẬN TRÊN (ngưỡng chọn ngay trên tập này) — chỉ để tham khảo, KHÔNG phải số báo cáo chính."""
    return threshold_for_fpr(y, score, max_fpr)["val_recall"]


def bootstrap_ci(y: np.ndarray, score: np.ndarray, threshold: float, n: int = 500, seed: int = 0, alpha: float = 0.05) -> dict:
    y = np.asarray(y).astype(int)
    score = np.asarray(score, dtype=float)
    rng = np.random.default_rng(seed)
    out = {"precision": [], "recall": [], "f1": []}
    N = len(y)
    if N == 0:
        return {}
    for _ in range(n):
        idx = rng.integers(0, N, N)
        rep = binary_report(y[idx], score[idx], threshold)
        for k in out:
            if not np.isnan(rep[k]):
                out[k].append(rep[k])
    return {k: [float(np.quantile(v, alpha / 2)), float(np.quantile(v, 1 - alpha / 2))] if v else [float("nan")] * 2 for k, v in out.items()}


def multiclass_report(y_true: list[str], y_pred: list[str], labels: list[str]) -> dict:
    cm = confusion_matrix(y_true, y_pred, labels=labels)
    per = {}
    for i, lb in enumerate(labels):
        tp = int(cm[i, i]); fp = int(cm[:, i].sum() - tp); fn = int(cm[i, :].sum() - tp)
        p = tp / (tp + fp) if tp + fp else float("nan")
        r = tp / (tp + fn) if tp + fn else float("nan")
        f = 2 * p * r / (p + r) if (tp + fp and tp + fn and p + r > 0) else float("nan")
        per[lb] = {"precision": p, "recall": r, "f1": f, "support": int(cm[i, :].sum())}
    return {"labels": labels, "confusion_matrix": cm.tolist(), "per_class": per}
