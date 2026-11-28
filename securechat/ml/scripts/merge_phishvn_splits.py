import sys
from pathlib import Path

import pandas as pd

root = Path("data/raw/phishvn")
parts = []
for name in ("train", "val", "test"):
    found = sorted(root.rglob(f"url_{name}.csv"))
    if len(found) != 1:
        sys.exit(f"Cần đúng 1 file url_{name}.csv trong {root}, tìm thấy {len(found)}: {[str(p) for p in found]}")
    print("đọc:", found[0])
    df = pd.read_csv(found[0], encoding="utf-8-sig")
    df["split"] = name
    parts.append(df)
out = pd.concat(parts, ignore_index=True)
out.to_csv(root / "phishvn.csv", index=False)
print("ghi:", root / "phishvn.csv")
print("số dòng theo split:", out["split"].value_counts().to_dict())
print("cột:", list(out.columns))
