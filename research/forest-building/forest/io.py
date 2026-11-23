"""Load sessions and gold labels; save and load forest snapshots."""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import ROOT
from .model import Forest, Prompt

SESSIONS = ROOT / "data" / "sessions"
GOLD = ROOT / "data" / "gold"
SESSION_IDS = ["s1_focused", "s2_mixed", "s3_drift"]


@dataclass
class Session:
    id: str
    description: str
    draft: bool
    prompts: list[Prompt]
    access_events: list[dict[str, Any]] = field(default_factory=list)  # {"step", "prompt_id"}

    def accesses_at(self, step: int) -> list[str]:
        return [e["prompt_id"] for e in self.access_events if e["step"] == step]


def load_session(session_id: str, folder: Path = SESSIONS) -> Session:
    data = json.loads((folder / f"{session_id}.json").read_text(encoding="utf-8"))
    prompts = [Prompt(id=p["id"], text=p["text"], step=p["step"], session_id=data["session_id"],
                      chat_id=p.get("chat_id", "c1")) for p in data["prompts"]]
    prompts.sort(key=lambda p: p.step)
    steps = [p.step for p in prompts]
    if steps != list(range(1, len(prompts) + 1)):
        raise ValueError(f"{session_id}: steps must be 1..n without gaps, got {steps}")
    known = {p.id for p in prompts}
    for e in data.get("access_events", []):
        if e["prompt_id"] not in known:
            raise ValueError(f"{session_id}: access event names unknown prompt {e['prompt_id']}")
        created = next(p.step for p in prompts if p.id == e["prompt_id"])
        if e["step"] <= created:
            raise ValueError(f"{session_id}: prompt {e['prompt_id']} opened at step {e['step']} before it exists")
    return Session(id=data["session_id"], description=data.get("description", ""), draft=bool(data.get("draft")),
                   prompts=prompts, access_events=data.get("access_events", []))


def load_sessions(ids: list[str] = SESSION_IDS) -> dict[str, Session]:
    return {s: load_session(s) for s in ids}


@dataclass(frozen=True)
class GoldLabel:
    prompt_id: str
    topic: str   # the topic label
    path: str    # 'Group > Root > ... > Topic'

    @property
    def parts(self) -> list[str]:
        return [x.strip() for x in self.path.split(">")]

    @property
    def group(self) -> str:
        return self.parts[0]

    @property
    def tree(self) -> str:
        return self.parts[1]


def load_gold(session_id: str, folder: Path = GOLD) -> dict[str, GoldLabel]:
    """Draft gold labels (data/gold/<session>.csv): prompt_id, text, gold_topic, gold_path."""
    path = folder / f"{session_id}.csv"
    with path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = {}
    for r in rows:
        label = GoldLabel(r["prompt_id"], r["gold_topic"].strip(), r["gold_path"].strip())
        if label.parts[-1] != label.topic:
            raise ValueError(f"{session_id} {r['prompt_id']}: path {label.path!r} must end with the topic {label.topic!r}")
        out[r["prompt_id"]] = label
    return out


def gold_forest(session: Session, gold: dict[str, GoldLabel], upto_step: int) -> Forest:
    """The forest the gold labels describe, built from the prompts with step < upto_step.

    Topic ids are the gold paths, so the same topic keeps its id across steps.
    """
    from .model import Group, Topic

    f = Forest(step=upto_step - 1)
    for p in session.prompts:
        if p.step >= upto_step:
            break
        g = gold[p.id]
        parts = g.parts
        gid = "G:" + parts[0]
        f.groups.setdefault(gid, Group(gid, parts[0]))
        parent, kind = gid, "group"
        for i in range(1, len(parts)):
            tid = "T:" + " > ".join(parts[: i + 1])
            if tid not in f.topics:
                f.topics[tid] = Topic(tid, parts[i], parent, kind)
            parent, kind = tid, "topic"
        f.prompts[p.id] = p
        f.assignment[p.id] = parent
        f.access_log[p.id] = p.step
    return f


def gold_topic_id(label: GoldLabel) -> str:
    return "T:" + label.path


# --- forest snapshots ------------------------------------------------------------------------------

def save_forest(forest: Forest, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(forest.to_json(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def load_forest(path: Path) -> Forest:
    return Forest.from_json(json.loads(Path(path).read_text(encoding="utf-8")))


def write_json(path: Path, value: Any, indent: int | None = 1) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=indent, default=str) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    with Path(path).open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
