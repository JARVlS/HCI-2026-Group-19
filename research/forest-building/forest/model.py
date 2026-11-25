"""The forest: groups, topics (tree nodes) and prompts, with the fit stored on every link.

A group sits directly under the forest. A topic whose parent is a group is a tree root; otherwise
its parent is another topic. Every prompt sits in exactly one topic. Each link keeps the rescaled
judge fit (0..1) it was created with, and each prompt its creation step (plan Section 4.1).
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

import yaml

from . import ROOT


@dataclass(frozen=True)
class Prompt:
    id: str
    text: str


@dataclass
class Placement:
    topic: str
    fit: float      # rescaled fit of the prompt-topic link when it was made
    created: int    # step at which the prompt arrived


@dataclass
class Topic:
    id: str
    label: str
    parent: str
    parent_kind: Literal["topic", "group"]
    fit: float      # rescaled fit of the link to the parent


@dataclass
class Group:
    id: str
    label: str


class ForestError(ValueError):
    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("invalid forest:\n  - " + "\n  - ".join(problems))


@dataclass
class Forest:
    groups: dict[str, Group] = field(default_factory=dict)
    topics: dict[str, Topic] = field(default_factory=dict)
    prompts: dict[str, Prompt] = field(default_factory=dict)
    placement: dict[str, Placement] = field(default_factory=dict)
    step: int = 0

    # --- navigation ------------------------------------------------------------------------------
    def children(self, t: str) -> list[str]:
        return [c.id for c in self.topics.values() if c.parent_kind == "topic" and c.parent == t]

    def roots(self, g: str | None = None) -> list[str]:
        return [c.id for c in self.topics.values() if c.parent_kind == "group" and (g is None or c.parent == g)]

    def prompts_in(self, t: str) -> list[str]:
        return sorted((p for p, pl in self.placement.items() if pl.topic == t),
                      key=lambda p: (self.placement[p].created, p))

    def subtree(self, t: str) -> list[str]:
        out, stack = [], [t]
        while stack:
            c = stack.pop()
            out.append(c)
            stack.extend(self.children(c))
        return out

    def subtree_prompts(self, t: str) -> list[str]:
        return [p for c in self.subtree(t) for p in self.prompts_in(c)]

    def ancestors(self, t: str) -> list[str]:
        out, c = [], self.topics[t]
        while c.parent_kind == "topic":
            if c.parent in out or c.parent == t:
                raise ForestError([f"topic {t!r} is on a cycle"])
            out.append(c.parent)
            c = self.topics[c.parent]
        return out

    def depth(self, t: str) -> int:
        return len(self.ancestors(t))

    def root_of(self, t: str) -> str:
        return ([t] + self.ancestors(t))[-1]

    def group_of(self, t: str) -> str:
        return self.topics[self.root_of(t)].parent

    def path(self, t: str) -> str:
        chain = ([t] + self.ancestors(t))[::-1]
        return " > ".join([self.groups[self.topics[chain[0]].parent].label] + [self.topics[c].label for c in chain])

    def copy(self) -> "Forest":
        return copy.deepcopy(self)

    # --- checks ----------------------------------------------------------------------------------
    def validate(self, D: int | None = None) -> "Forest":
        """Each prompt in exactly one existing topic, each topic under an existing parent, no
        cycles, depth <= D-1 (root = 0), no empty topics or groups."""
        bad: list[str] = []
        for p in self.prompts:
            if p not in self.placement:
                bad.append(f"prompt {p} is in no topic")
            elif self.placement[p].topic not in self.topics:
                bad.append(f"prompt {p} is in unknown topic {self.placement[p].topic}")
        for t in self.topics.values():
            known = self.groups if t.parent_kind == "group" else self.topics
            if t.parent not in known:
                bad.append(f"topic {t.id} ({t.label!r}) hangs under unknown {t.parent_kind} {t.parent}")
        if not bad:
            for t in self.topics:
                try:
                    d = self.depth(t)
                except ForestError:
                    bad.append(f"topic {t} ({self.topics[t].label!r}) is on a cycle")
                    continue
                if D is not None and d > D - 1:
                    bad.append(f"topic {t} ({self.topics[t].label!r}) is at depth {d}, deeper than D-1 = {D - 1}")
            for t in self.topics.values():
                if not self.prompts_in(t.id) and not self.children(t.id):
                    bad.append(f"topic {t.id} ({t.label!r}) is empty")
            for g in self.groups.values():
                if not self.roots(g.id):
                    bad.append(f"group {g.id} ({g.label!r}) is empty")
        if bad:
            raise ForestError(bad)
        return self

    # --- JSON ------------------------------------------------------------------------------------
    def to_json(self) -> dict:
        return {"step": self.step,
                "groups": [asdict(g) for g in self.groups.values()],
                "topics": [asdict(t) for t in self.topics.values()],
                "prompts": [{**asdict(self.prompts[p]), **asdict(pl)} for p, pl in self.placement.items()]}

    @classmethod
    def from_json(cls, data: dict) -> "Forest":
        f = cls(step=data["step"])
        f.groups = {g["id"]: Group(**g) for g in data["groups"]}
        f.topics = {t["id"]: Topic(**t) for t in data["topics"]}
        for p in data["prompts"]:
            f.prompts[p["id"]] = Prompt(p["id"], p["text"])
            f.placement[p["id"]] = Placement(p["topic"], p["fit"], p["created"])
        return f

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


# --- the ideal forest --------------------------------------------------------------------------------

@dataclass
class Ideal:
    session: str
    forest: Forest                        # every prompt in its ideal topic (all fits 1.0, created 0)
    arrival: list[str]                    # prompt ids in arrival order
    intended: dict[str, tuple[str, str]]  # prompt id -> (outcome letter, why)

    def topic_of(self, p: str) -> str:
        return self.forest.placement[p].topic

    def upto(self, k: int) -> Forest:
        """The ideal forest holding only the first k arrived prompts (empty categories dropped)."""
        keep = set(self.arrival[:k])
        f = self.forest.copy()
        f.prompts = {p: v for p, v in f.prompts.items() if p in keep}
        f.placement = {p: v for p, v in f.placement.items() if p in keep}
        for p in f.placement:
            f.placement[p].created = self.arrival.index(p) + 1
        changed = True
        while changed:
            changed = False
            for t in list(f.topics):
                if not f.prompts_in(t) and not f.children(t):
                    del f.topics[t]
                    changed = True
            for g in list(f.groups):
                if not f.roots(g):
                    del f.groups[g]
                    changed = True
        f.step = k
        return f


def slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")


def load_ideal(path: Path = ROOT / "data" / "ideal_forest.yaml") -> Ideal:
    text = Path(path).read_text(encoding="utf-8")
    data = yaml.safe_load(text)
    f = Forest()

    def add(node: dict, parent: str, kind: str) -> None:
        tid = "t_" + slug(node["label"])
        f.topics[tid] = Topic(tid, node["label"], parent, kind, 1.0)
        for p in node.get("prompts", []):
            f.prompts[p["id"]] = Prompt(p["id"], p["text"])
            f.placement[p["id"]] = Placement(tid, 1.0, 0)
        for child in node.get("children", []):
            add(child, tid, "topic")

    for g in data["groups"]:
        gid = "g_" + slug(g["label"])
        f.groups[gid] = Group(gid, g["label"])
        for tree in g["trees"]:
            add(tree, gid, "group")
    intended = {}
    for line in text.split("arrival_order:", 1)[1].splitlines():
        m = re.match(r"\s*-\s*(\w+)\s*#\s*\((\w)\)\s*(.*)", line)
        if m:
            intended[m.group(1)] = (m.group(2), m.group(3).strip())
    arrival = list(data["arrival_order"])
    if sorted(arrival) != sorted(f.prompts):
        raise ValueError("arrival_order must list every prompt of the ideal forest exactly once")
    return Ideal(data["session"], f.validate(), arrival, intended)
