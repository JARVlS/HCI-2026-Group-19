"""Export forests for the prototype (plan Phase 7, open decision 6).

Two formats:
- native: Forest.to_json() per step (outputs/forests/<session>/<method>/step_XX.json) plus the
  decision log decisions.jsonl (action and diff per step);
- app: the canonical data model of the frontend (IMPLEMENTATION_PLAN.md ADR-2, frontend/src/lib/domain.ts):
  groups -> Concept kind 'subject'; tree roots -> Concept kind 'topic'; deeper topics -> kind
  'concept'; one KnowledgeTree per root (id 't:<root id>', as planner.ts applyPlan derives it,
  groveId = the group); one ConceptAttempt per prompt (conversationId '<session>:<chat>',
  messageId = prompt id). Attempt fields the forest does not know (mode, independence) get neutral
  placeholders and reasons ['placed by the forest IP'] so they are recognisable.
Ids stay stable across steps (a rename keeps the id), so the app can animate a move.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .io import write_json
from .model import Forest

BASE_TIME = datetime(2026, 12, 1, 9, 0, tzinfo=timezone.utc)


def iso(step: int) -> str:
    return (BASE_TIME + timedelta(minutes=2 * step)).isoformat().replace("+00:00", "Z")


def slug(label: str) -> str:
    s = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r"s\b", "", s)  # singular-ish, as the app's slug


def to_app(f: Forest, first_seen: dict[str, int] | None = None) -> dict:
    """One forest as {concepts, trees, attempts} in the app's wire format (camelCase)."""
    first_seen = first_seen or {}
    now = iso(f.step)
    concepts = []
    for g in f.groups.values():
        t0 = iso(first_seen.get(g.id, f.step))
        concepts.append({"id": g.id, "label": g.label, "slug": slug(g.label), "aliases": [], "kind": "subject",
                         "parentId": None, "createdBy": "llm", "createdAt": t0, "updatedAt": now})
    for t in f.topics.values():
        t0 = iso(first_seen.get(t.id, f.step))
        concepts.append({"id": t.id, "label": t.label, "slug": slug(t.label), "aliases": [],
                         "kind": "topic" if t.parent_kind == "group" else "concept",
                         "parentId": t.parent_id, "createdBy": "llm", "createdAt": t0, "updatedAt": now})
    trees = [{"id": f"t:{r}", "rootConceptId": r, "title": f.topics[r].label, "groveId": f.topics[r].parent_id,
              "createdAt": iso(first_seen.get(r, f.step)), "updatedAt": now} for r in f.roots()]
    attempts = []
    for p in sorted(f.prompts.values(), key=lambda p: p.step):
        attempts.append({"id": f"a:{p.id}", "conversationId": f"{p.session_id}:{p.chat_id}", "messageId": p.id,
                         "conceptId": f.assignment[p.id], "mode": "together", "independence": 0.5,
                         "correctness": None, "confidence": 1.0, "reasons": ["placed by the forest IP"],
                         "evidence": [], "source": "prompt", "createdAt": iso(p.step)})
    messages = [{"id": p.id, "conversationId": f"{p.session_id}:{p.chat_id}", "role": "user", "text": p.text,
                 "createdAt": iso(p.step)} for p in sorted(f.prompts.values(), key=lambda p: p.step)]
    return {"concepts": concepts, "trees": trees, "attempts": attempts, "messages": messages}


def export_sequence(forests: list[Forest], decisions: list[dict] | None, out_dir: Path, meta: dict) -> Path:
    """Write the app-format sequence: one snapshot per step plus the decision of that step."""
    first_seen: dict[str, int] = {}
    steps = []
    for i, f in enumerate(forests):
        for c in [*f.groups, *f.topics]:
            first_seen.setdefault(c, f.step)
        entry = {"step": f.step, "snapshot": to_app(f, first_seen)}
        if decisions:
            d = decisions[i]
            entry["decision"] = {k: d[k] for k in ("action", "topic", "diff") if k in d}
        steps.append(entry)
    path = Path(out_dir) / "app_sequence.json"
    write_json(path, {"format": "arbor-forest-sequence/1", **meta, "steps": steps}, indent=None)
    write_json(Path(out_dir) / "app_final.json", {"format": "arbor-forest/1", **meta, **steps[-1]["snapshot"]})
    return path
