"""Paths and JSON Lines helpers shared by the steps."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "out"
CACHE = ROOT / "cache"

SYNTHETIC = DATA / "synthetic.jsonl"
HABIT = DATA / "habit.jsonl"
LABELS = DATA / "labels.jsonl"
SONNET = DATA / "sonnet.jsonl"
WEIGHTS = OUT / "weights.json"
VECTORS = OUT / "vectors.json"
RESULTS = OUT / "results.json"


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_json(path: Path, value, indent: int | None = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
