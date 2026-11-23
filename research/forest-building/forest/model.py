"""The forest: groups, topics (tree nodes) and the prompts attached to topics.

A group sits directly under the forest. A topic whose parent is a group is a tree root; otherwise
its parent is another topic. Every prompt belongs to exactly one topic.
"""
from __future__ import annotations

import copy
from dataclasses import asdict, dataclass, field
from typing import Literal

FORMAT_VERSION = 1
ParentKind = Literal["topic", "group"]


@dataclass(frozen=True)
class Prompt:
    id: str
    text: str
    step: int
    session_id: str
    chat_id: str = "c1"


@dataclass
class Topic:
    id: str
    label: str
    parent_id: str
    parent_kind: ParentKind


@dataclass
class Group:
    id: str
    label: str


class ForestError(ValueError):
    """An invalid forest. `problems` lists every violation found."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("invalid forest:\n  - " + "\n  - ".join(problems))


@dataclass
class Forest:
    groups: dict[str, Group] = field(default_factory=dict)
    topics: dict[str, Topic] = field(default_factory=dict)
    prompts: dict[str, Prompt] = field(default_factory=dict)
    assignment: dict[str, str] = field(default_factory=dict)  # prompt id -> topic id
    access_log: dict[str, int] = field(default_factory=dict)  # prompt id -> step created or last opened
    step: int = 0

    # --- navigation ------------------------------------------------------------------------------

    def children(self, topic_id: str) -> list[str]:
        return [t.id for t in self.topics.values() if t.parent_kind == "topic" and t.parent_id == topic_id]

    def roots(self, group_id: str | None = None) -> list[str]:
        return [t.id for t in self.topics.values()
                if t.parent_kind == "group" and (group_id is None or t.parent_id == group_id)]

    def prompts_in(self, topic_id: str) -> list[str]:
        """Prompts attached directly to this topic, in step order."""
        ids = [p for p, t in self.assignment.items() if t == topic_id]
        return sorted(ids, key=lambda p: (self.prompts[p].step, p))

    def subtree(self, topic_id: str) -> list[str]:
        """The topic and all topics below it."""
        out, stack = [], [topic_id]
        while stack:
            c = stack.pop()
            out.append(c)
            stack.extend(self.children(c))
        return out

    def subtree_prompts(self, topic_id: str) -> list[str]:
        return [p for c in self.subtree(topic_id) for p in self.prompts_in(c)]

    def group_prompts(self, group_id: str) -> list[str]:
        return [p for r in self.roots(group_id) for p in self.subtree_prompts(r)]

    def ancestors(self, topic_id: str) -> list[str]:
        """Topic ids from the parent up to the tree root (excluding the group)."""
        out, c, seen = [], self.topics[topic_id], {topic_id}
        while c.parent_kind == "topic":
            if c.parent_id in seen:
                raise ForestError([f"cycle through topic {c.parent_id}"])
            seen.add(c.parent_id)
            out.append(c.parent_id)
            c = self.topics[c.parent_id]
        return out

    def depth(self, topic_id: str) -> int:
        return len(self.ancestors(topic_id))

    def root_of(self, topic_id: str) -> str:
        chain = [topic_id, *self.ancestors(topic_id)]
        return chain[-1]

    def group_of(self, topic_id: str) -> str:
        return self.topics[self.root_of(topic_id)].parent_id

    def path(self, topic_id: str, sep: str = " > ") -> str:
        """'Group > Root > ... > Topic'."""
        chain = [topic_id, *self.ancestors(topic_id)][::-1]
        labels = [self.groups[self.topics[chain[0]].parent_id].label] + [self.topics[c].label for c in chain]
        return sep.join(labels)

    def parent_of(self, topic_id: str) -> tuple[str, ParentKind]:
        t = self.topics[topic_id]
        return t.parent_id, t.parent_kind

    def copy(self) -> "Forest":
        return copy.deepcopy(self)

    # --- checks ----------------------------------------------------------------------------------

    def problems(self, D: int | None = None) -> list[str]:
        """Every violation of the forest invariants; empty when valid."""
        out: list[str] = []
        for p, t in self.assignment.items():
            if p not in self.prompts:
                out.append(f"assignment names unknown prompt {p}")
            if t not in self.topics:
                out.append(f"prompt {p} is in unknown topic {t}")
        for p in self.prompts:
            if p not in self.assignment:
                out.append(f"prompt {p} is in no topic")
        for t in self.topics.values():
            if t.parent_kind == "group" and t.parent_id not in self.groups:
                out.append(f"topic {t.id} ({t.label!r}) hangs under unknown group {t.parent_id}")
            elif t.parent_kind == "topic" and t.parent_id not in self.topics:
                out.append(f"topic {t.id} ({t.label!r}) hangs under unknown topic {t.parent_id}")
            elif t.parent_kind == "topic" and t.parent_id == t.id:
                out.append(f"topic {t.id} ({t.label!r}) is its own parent")
        if out:
            return out  # the remaining checks walk parents, which needs the above to hold
        for t in self.topics:
            try:
                d = self.depth(t)
            except ForestError:
                out.append(f"topic {t} ({self.topics[t].label!r}) is on a cycle")
                continue
            if D is not None and d > D - 1:
                out.append(f"topic {t} ({self.topics[t].label!r}) is at depth {d}, deeper than D-1 = {D - 1}")
        for t in self.topics.values():
            if not self.prompts_in(t.id) and not self.children(t.id):
                out.append(f"topic {t.id} ({t.label!r}) is empty: no prompts and no subtopics")
        for g in self.groups.values():
            if not self.roots(g.id):
                out.append(f"group {g.id} ({g.label!r}) is empty: no trees")
        return out

    def validate(self, D: int | None = None) -> "Forest":
        problems = self.problems(D)
        if problems:
            raise ForestError(problems)
        return self

    # --- JSON (also the export format for the prototype; see forest/export.py for the app's schema)

    def to_json(self) -> dict:
        return {
            "version": FORMAT_VERSION,
            "step": self.step,
            "groups": [asdict(g) for g in self.groups.values()],
            "topics": [asdict(t) for t in self.topics.values()],
            "prompts": [asdict(p) for p in sorted(self.prompts.values(), key=lambda p: (p.step, p.id))],
            "assignment": dict(sorted(self.assignment.items())),
            "access_log": dict(sorted(self.access_log.items())),
        }

    @classmethod
    def from_json(cls, data: dict) -> "Forest":
        if data.get("version") != FORMAT_VERSION:
            raise ValueError(f"unsupported forest format version {data.get('version')!r}")
        return cls(
            groups={g["id"]: Group(**g) for g in data["groups"]},
            topics={t["id"]: Topic(**t) for t in data["topics"]},
            prompts={p["id"]: Prompt(**p) for p in data["prompts"]},
            assignment=dict(data["assignment"]),
            access_log={k: int(v) for k, v in data["access_log"].items()},
            step=int(data["step"]),
        )

    def render(self) -> str:
        """A plain-text outline: groups, topics indented by depth, prompt counts."""
        lines = []
        for g in self.groups.values():
            lines.append(f"[{g.label}]")

            def walk(c: str, indent: int) -> None:
                t = self.topics[c]
                lines.append("  " * indent + f"- {t.label} ({len(self.prompts_in(c))})")
                for ch in sorted(self.children(c), key=lambda x: self.topics[x].label):
                    walk(ch, indent + 1)

            for r in sorted(self.roots(g.id), key=lambda x: self.topics[x].label):
                walk(r, 1)
        return "\n".join(lines) if lines else "(empty forest)"
