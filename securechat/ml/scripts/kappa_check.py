"""Tính Cohen's kappa giữa lần gán nhãn thứ nhất và lần gán lại (LABELING_GUIDE.md mục 6).

Cách dùng (từ thư mục chứa hai tệp):
    python kappa_check.py --key dap_an_lan1_60.csv --labels gan_doc_lap_60.xlsx

--labels nhận .xlsx (sheet "Gán nhãn", cần openpyxl) hoặc .csv (cột stt,text,label).
Kết quả in ra màn hình và ghi danh sách tin hai lần gán khác nhau vào kappa_disagreements.csv.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

LABELS = ["benign", "spam", "scam"]


def read_second(path: Path) -> list[dict]:
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    try:
        from openpyxl import load_workbook
    except ImportError:
        sys.exit("Thiếu openpyxl. Cài bằng `pip install openpyxl` hoặc lưu sheet 'Gán nhãn' thành CSV UTF-8.")
    wb = load_workbook(path, data_only=True)
    ws = wb["Gán nhãn"] if "Gán nhãn" in wb.sheetnames else wb.worksheets[0]
    head = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
    out = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        d = {h: v for h, v in zip(head, r) if h}
        if d.get("stt") is None and not d.get("text"):
            continue
        out.append(d)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True, help="dap_an_lan1_60.csv (nhãn lần 1)")
    ap.add_argument("--labels", required=True, help="tệp lần gán 2 (.xlsx hoặc .csv)")
    ap.add_argument("--out", default="kappa_disagreements.csv")
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):  # in tiếng Việt đúng trên console Windows
        sys.stdout.reconfigure(encoding="utf-8")
    import pandas as pd
    from sklearn.metrics import cohen_kappa_score

    key = pd.read_csv(a.key, encoding="utf-8-sig")
    sec = pd.DataFrame(read_second(Path(a.labels)))
    sec["stt"] = pd.to_numeric(sec["stt"], errors="coerce")
    sec["label2"] = sec["label"].astype(str).str.strip().str.lower().replace({"nan": "", "none": ""})
    bad = sec[~sec["label2"].isin(LABELS)]
    if len(bad):
        sys.exit(f"Có {len(bad)} dòng thiếu hoặc sai nhãn (stt: {bad['stt'].astype('Int64').tolist()}). Điền đủ benign/spam/scam rồi chạy lại.")
    df = key.merge(sec[["stt", "text", "label2", "note"]].rename(columns={"stt": "stt_moi"}), on="stt_moi", how="left")
    if df["label2"].isna().any():
        sys.exit("Thiếu stt trong tệp gán lại; số dòng khác 60.")
    n = len(df)
    y1, y2 = df["label_lan1"], df["label2"]
    agree = (y1 == y2).mean()
    kappa = cohen_kappa_score(y1, y2, labels=LABELS)
    r1, r2 = (y1 != "benign").astype(int), (y2 != "benign").astype(int)
    kappa_risk = cohen_kappa_score(r1, r2)
    print(f"Số tin: {n}")
    print(f"Đồng thuận: {agree:.1%}   Cohen's kappa (3 nhãn): {kappa:.3f}")
    print(f"Kappa nhóm rủi ro (spam+scam so với benign): {kappa_risk:.3f}   đồng thuận {(r1 == r2).mean():.1%}")
    print("\nMa trận nhầm lẫn (hàng = lần 1, cột = lần 2):")
    print(pd.crosstab(y1, y2).reindex(index=LABELS, columns=LABELS, fill_value=0).to_string())
    diff = df[y1 != y2].copy()
    print(f"\nSố tin khác nhau: {len(diff)}")
    for _, r in diff.iterrows():
        print(f"  stt_goc {int(r['stt_goc']):>3} | lần 1: {r['label_lan1']:<6} lần 2: {r['label2']:<6} | {str(r['text'])[:90]}")
    diff[["stt_goc", "label_lan1", "label2", "note", "text"]].rename(columns={"label2": "label_lan2"}).to_csv(a.out, index=False, encoding="utf-8-sig")
    print(f"\nĐã ghi {a.out}")
    if kappa < 0.6:
        print("Kappa dưới 0,6: ranh giới nhãn chưa rõ. Theo guide mục 6, bổ sung quy tắc ở mục 4 trước khi gán tiếp.")
    else:
        print("Kappa từ 0,6 trở lên: đạt mức nhất quán theo guide.")


if __name__ == "__main__":
    main()
