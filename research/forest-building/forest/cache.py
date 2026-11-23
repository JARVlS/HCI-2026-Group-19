"""Disk cache for every embedding and judge call, plus a ledger and budget for live calls.

Entries live in data/cache/<store>.jsonl (git-ignored), keyed by a hash of (model, input, template
version). data/frozen/<store>.jsonl is a committed read-only snapshot of the cache, so the
submission notebook runs without models or API keys:

    python -m forest.cache freeze     # copy data/cache/{embeddings,judge}.jsonl to data/frozen/
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import ROOT

CACHE = ROOT / "data" / "cache"
FROZEN = ROOT / "data" / "frozen"
FROZEN_STORES = ("embeddings", "judge")
_lock = threading.Lock()

# Set True to forbid any model load or API call: a cache miss raises CacheMiss instead
# (ui_optimization.ipynb sets it, so a run proves it needs nothing but data/frozen/).
REQUIRE_CACHED = False


class CacheMiss(RuntimeError):
    pass


def key(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Store:
    """An append-only JSON Lines file of cached values, loaded once; falls back to data/frozen/."""

    def __init__(self, name: str, cache: Path = CACHE, frozen: Path = FROZEN):
        self.name = name
        self.path = cache / f"{name}.jsonl"
        self.rows: dict[str, Any] = {}
        self.hits = 0
        self.misses = 0
        for p in (frozen / f"{name}.jsonl", self.path):
            if p.exists():
                for line in p.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        row = json.loads(line)
                        self.rows[row["key"]] = row["value"]

    def get(self, k: str) -> Any | None:
        v = self.rows.get(k)
        if v is None:
            self.misses += 1
        else:
            self.hits += 1
        return v

    def __contains__(self, k: str) -> bool:
        return k in self.rows

    def put(self, k: str, value: Any, **meta: Any) -> None:
        with _lock:
            if k in self.rows:
                return
            self.rows[k] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"key": k, "value": value, **meta}, ensure_ascii=False) + "\n")


_stores: dict[str, Store] = {}


def store(name: str) -> Store:
    if name not in _stores:
        _stores[name] = Store(name)
    return _stores[name]


class BudgetExceeded(RuntimeError):
    pass


class Ledger:
    """Counts every live judge attempt (also failed ones) across runs, in data/cache/ledger.jsonl."""

    def __init__(self, path: Path = CACHE / "ledger.jsonl"):
        self.path = path
        self.calls = 0
        self.run_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    self.calls += 1
                    self.input_tokens += row.get("in", 0)
                    self.output_tokens += row.get("out", 0)

    def reserve(self, total_max: int, run_max: int) -> None:
        with _lock:
            if self.calls + 1 > total_max:
                raise BudgetExceeded(f"judge budget: {self.calls} of {total_max} live calls used (judge.total_max_calls)")
            if self.run_calls + 1 > run_max:
                raise BudgetExceeded(f"run budget: {self.run_calls} of {run_max} live calls in this run (judge.max_calls_per_run)")

    def add(self, row: dict) -> None:
        with _lock:
            self.calls += 1
            self.run_calls += 1
            self.input_tokens += row.get("in", 0)
            self.output_tokens += row.get("out", 0)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"t": round(time.time()), **row}) + "\n")


_ledger: Ledger | None = None


def ledger() -> Ledger:
    global _ledger
    if _ledger is None:
        _ledger = Ledger()
    return _ledger


def freeze() -> None:
    """Snapshot the working cache into data/frozen/ (committed)."""
    FROZEN.mkdir(parents=True, exist_ok=True)
    for name in FROZEN_STORES:
        src = CACHE / f"{name}.jsonl"
        if not src.exists():
            print(f"{name}: nothing cached")
            continue
        # merge frozen + cache, one row per key, so freezing twice never duplicates
        rows: dict[str, str] = {}
        for p in (FROZEN / f"{name}.jsonl", src):
            if p.exists():
                for line in p.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        rows[json.loads(line)["key"]] = line
        tmp = FROZEN / f"{name}.jsonl.tmp"
        tmp.write_text("\n".join(rows.values()) + "\n", encoding="utf-8")
        shutil.move(tmp, FROZEN / f"{name}.jsonl")
        print(f"{name}: {len(rows)} entries frozen")


if __name__ == "__main__":
    if sys.argv[1:] == ["freeze"]:
        freeze()
    else:
        print(__doc__)
