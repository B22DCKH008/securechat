"""Đường dẫn + nạp config. Chế độ --demo tách hẳn thư mục để không lẫn với dữ liệu thật."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import yaml

ML_ROOT = Path(os.environ.get("SECURECHAT_ML_ROOT", Path(__file__).resolve().parents[2]))


class Paths:
    def __init__(self, root: Path | str = ML_ROOT, demo: bool = False):
        self.root = Path(root)
        self.demo = demo

    def config(self, name: str) -> Path:
        return self.root / "configs" / name

    @property
    def raw_dir(self) -> Path:
        return self.root / "data" / ("demo/raw" if self.demo else "raw")

    def splits_dir(self, kind: str) -> Path:
        return self.root / "data" / "splits" / ("demo" if self.demo else "") / kind

    def artifacts_dir(self, kind: str) -> Path:
        return self.root / ("models/demo_artifacts" if self.demo else "models/artifacts") / kind

    def reports_dir(self) -> Path:
        return self.root / ("reports/demo" if self.demo else "reports")


def load_yaml(path: Path | str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_cfg(paths: Paths, name: str) -> dict:
    return load_yaml(paths.config(name))


def message_labels(paths: Paths) -> list[str]:
    return [d["id"] for d in load_cfg(paths, "labels.yaml")["message_model"]["labels"]]


def risky_labels(paths: Paths) -> list[str]:
    return list(load_cfg(paths, "labels.yaml")["message_model"]["risky_labels"])


def sha256_file(path: Path | str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_obj(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def write_json(path: Path | str, obj, indent: int | None = 2) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)


def read_json(path: Path | str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
