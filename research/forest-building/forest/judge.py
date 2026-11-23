"""The judge: scores and candidate names for one placement step. It never decides placement.

Three calls (plan Phase 3):
  1. placement     one per new prompt: fit of the prompt to shortlisted topics, up to
                   `max_proposed` new topics with parent fits (hierarchy call merged in, as the plan
                   allows), optional renames.
  2. neighbourhood only when topics are proposed: fit of nearby old prompts to the proposed topics,
                   of old topics as children of proposed topics, and of old trees under proposed
                   new groups (the rest of the hierarchy call).
  4. restructure   whole forest at once (baseline `judge_restructure` only).

Backends:
  offline    deterministic embedding stand-in. NOT an LLM: fits are calibrated cosines, names are
             key phrases, new groups come from a fixed subject list. For tests and pipeline runs.
  anthropic  Claude API through the official SDK (structured JSON output).
  proxy      the same SDK against an Anthropic-compatible endpoint at PROXY_URL.
Every live answer is cached (forest.cache) keyed by model, template version and the exact input.
"""
from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, Field, ValidationError

from . import cache
from .embed import Embedder, cal_bounds, calibrate, keyphrases, prompt_topic_cosine
from .model import Forest

TEMPLATE_VERSION = "2026-11-23.1"
NEW_GROUP = "NEW_GROUP:"

Fit = Literal[1, 2, 3, 4, 5]


# --- outputs ---------------------------------------------------------------------------------------

class ExistingFit(BaseModel):
    topic_id: str
    fit: Fit


class ParentFit(BaseModel):
    id: str = Field(description="an existing topic id, an existing group id, or NEW_GROUP:<name>")
    fit: Fit


class ProposedTopic(BaseModel):
    name: str
    fit: Fit
    parents: list[ParentFit]


class Rename(BaseModel):
    topic_id: str
    new_name: str
    fit: Fit


class PlacementOut(BaseModel):
    existing: list[ExistingFit]
    proposed: list[ProposedTopic]
    renames: list[Rename] = []


class PromptFit(BaseModel):
    prompt_id: str
    proposed: str
    fit: Fit


class ChildFit(BaseModel):
    topic_id: str
    proposed: str
    fit: Fit


class RootGroupFit(BaseModel):
    topic_id: str
    group: str
    fit: Fit


class NeighbourhoodOut(BaseModel):
    prompts: list[PromptFit]
    children: list[ChildFit] = []
    roots: list[RootGroupFit] = []


class RestructureTopic(BaseModel):
    name: str
    parent: str = Field(description="GROUP:<group name> for a tree root, else the name of another topic")
    prompt_ids: list[str]


class RestructureOut(BaseModel):
    groups: list[str]
    topics: list[RestructureTopic]


# --- requests --------------------------------------------------------------------------------------

@dataclass
class Candidate:
    id: str
    path: str
    examples: list[str]


@dataclass
class PlacementRequest:
    prompt_id: str
    text: str
    candidates: list[Candidate]
    groups: list[tuple[str, str]]  # (id, label)
    forest: Forest = field(repr=False, default=None)  # only the offline judge reads it
    order_seed: int = 0
    repeat: int = 0  # only in the cache key: a second live call with the same input (consistency check)


@dataclass
class NeighbourhoodRequest:
    proposed: list[str]                          # proposed topic names
    new_groups: list[str]                        # proposed new group names
    prompts: list[tuple[str, str]]               # (prompt id, text) of nearby old prompts
    topics: list[tuple[str, str]]                # (topic id, path) of nearby old topics
    roots: list[tuple[str, str]]                 # (topic id, path) of old tree roots
    forest: Forest = field(repr=False, default=None)
    order_seed: int = 0


@dataclass
class JudgeMeta:
    model: str
    cached: bool = False
    calls: int = 0
    failures: list[str] = field(default_factory=list)
    latency_s: float = 0.0


SCALE = """Fit scale (use exactly these integers):
5 = exactly this topic
4 = a subtopic of this topic that does not exist yet
3 = same broader area
2 = loosely related
1 = unrelated"""

PLACEMENT_SYSTEM = f"""You help organise the questions a student asks a tutor into a knowledge forest.
Groups (subjects) contain trees of topics; every question sits in exactly one topic.
You do NOT decide where a question goes. You rate fits and propose candidate topics; an optimiser decides.

{SCALE}

Tasks:
1. Rate how well the new question fits every listed existing topic.
2. If any rating is 4 or no rating is 5, propose up to {{max_proposed}} new topics. A topic name is
   short (1 to 4 words) and names a concept a student would look for later, not the question
   rephrased. Rate the new question against each proposed topic (fit). For each proposed topic,
   rate possible parents with the same scale (5 = the natural parent): existing topics or groups by
   their id, or a new group written exactly NEW_GROUP:<subject name>.
3. Optional: if an existing topic's name no longer describes its questions together with the new
   one, propose a rename (topic_id, new_name, fit of the new name to the topic's questions).
Return only the JSON object."""

NEIGHBOURHOOD_SYSTEM = f"""You help organise the questions a student asks a tutor into a knowledge forest.
Some new topics were proposed. Rate, with the fit scale below:
- prompts: how well each listed existing question fits each proposed topic (5 = it belongs there);
- children: how well each listed existing topic would sit as a subtopic under each proposed topic
  (5 = clearly a subtopic of it; rate only pairs above 1, omit the rest);
- roots: how well each listed existing tree belongs in each proposed new group (omit pairs at 1).
You do not decide anything; an optimiser does.

{SCALE}

Return only the JSON object."""

RESTRUCTURE_SYSTEM = """You organise all questions a student asked a tutor into a knowledge forest.
Groups are subjects. Each group holds trees of topics, at most 3 levels deep. Every question goes in
exactly one topic. Topic names are short (1 to 4 words) concepts a student would look for. Aim for
about 2 to 6 questions per topic and at most 4 trees per group. A tree root's parent is
GROUP:<group name>; any other topic's parent is the exact name of another topic.
Return only the JSON object."""


def _schema(model: type[BaseModel]) -> dict:
    """JSON schema for structured output: inline refs, no defaults, closed objects."""
    raw = model.model_json_schema()
    defs = raw.pop("$defs", {})

    def fix(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return fix(defs[node["$ref"].split("/")[-1]])
            node = {k: fix(v) for k, v in node.items() if k not in ("default", "title")}
            if node.get("type") == "object":
                node["additionalProperties"] = False
                node["required"] = list(node.get("properties", {}))
            return node
        if isinstance(node, list):
            return [fix(x) for x in node]
        return node

    return fix(raw)


def render_placement(req: PlacementRequest, examples_per_topic: int) -> str:
    rng = random.Random(f"{req.order_seed}:{req.prompt_id}")
    cands = list(req.candidates)
    rng.shuffle(cands)
    lines = ["New question:", f"<question>{req.text}</question>", "", "Existing topics (id | path | example questions):"]
    if not cands:
        lines.append("(none yet)")
    for c in cands:
        ex = " ; ".join(json.dumps(e, ensure_ascii=False) for e in c.examples[:examples_per_topic])
        lines.append(f"- {c.id} | {c.path} | {ex}")
    lines += ["", "Existing groups (id | name):"]
    lines += [f"- {g} | {label}" for g, label in req.groups] or ["(none yet)"]
    return "\n".join(lines)


def render_neighbourhood(req: NeighbourhoodRequest) -> str:
    rng = random.Random(f"{req.order_seed}:{'|'.join(req.proposed)}")
    prompts = list(req.prompts)
    rng.shuffle(prompts)
    lines = ["Proposed topics:"] + [f"- {p}" for p in req.proposed]
    if req.new_groups:
        lines += ["", "Proposed new groups:"] + [f"- {g}" for g in req.new_groups]
    lines += ["", "Existing questions (id | text):"] + [f"- {i} | {json.dumps(t, ensure_ascii=False)}" for i, t in prompts]
    if req.topics:
        lines += ["", "Existing topics (id | path):"] + [f"- {i} | {p}" for i, p in req.topics]
    if req.roots and req.new_groups:
        lines += ["", "Existing trees (root topic id | path):"] + [f"- {i} | {p}" for i, p in req.roots]
    return "\n".join(lines)


def render_restructure(forest: Forest) -> str:
    lines = ["Questions (id | text):"]
    for p in sorted(forest.prompts.values(), key=lambda p: p.step):
        lines.append(f"- {p.id} | {json.dumps(p.text, ensure_ascii=False)}")
    return "\n".join(lines)


# --- the judge -------------------------------------------------------------------------------------

class Judge:
    """Facade over the backends. `placement`, `neighbourhood` and `restructure` return
    (validated output, JudgeMeta)."""

    def __init__(self, cfg: dict, emb: Embedder, backend: str | None = None, model: str | None = None):
        self.cfg = cfg
        self.jcfg = cfg["judge"]
        self.backend = backend or self.jcfg["backend"]
        self.model = model or (self.jcfg["model"] if self.backend == self.jcfg["backend"] else None)
        if self.backend == "offline":
            self.impl: Any = OfflineJudge(cfg, emb)
            self.model = self.impl.model
        elif self.backend in ("anthropic", "proxy"):
            if not self.model:
                raise ValueError(f"judge backend {self.backend} needs a model id")
            self.impl = LLMJudge(cfg, self.backend, self.model)
        else:
            raise ValueError(f"unknown judge backend {self.backend!r}")

    @property
    def live(self) -> bool:
        return self.backend != "offline"

    def estimate_calls(self, n_steps: int) -> int:
        """Upper bound on live calls for n placement steps (placement + neighbourhood each)."""
        return 0 if not self.live else 2 * n_steps

    def placement(self, req: PlacementRequest) -> tuple[PlacementOut, JudgeMeta]:
        out, meta = self.impl.placement(req)
        return _clean_placement(out, req, self.jcfg["max_proposed"]), meta

    def neighbourhood(self, req: NeighbourhoodRequest) -> tuple[NeighbourhoodOut, JudgeMeta]:
        return self.impl.neighbourhood(req)

    def restructure(self, forest: Forest) -> tuple[RestructureOut, JudgeMeta]:
        return self.impl.restructure(forest)


def _clean_placement(out: PlacementOut, req: PlacementRequest, max_proposed: int) -> PlacementOut:
    """Drop references to unknown ids and duplicate names; keep at most max_proposed proposals."""
    topic_ids = {c.id for c in req.candidates}
    group_ids = {g for g, _ in req.groups}
    existing = {e.topic_id: e for e in out.existing if e.topic_id in topic_ids}
    proposed, seen = [], set()
    for p in out.proposed:
        name = p.name.strip()
        if not name or name.lower() in seen:
            continue
        parents = [pa for pa in p.parents
                   if pa.id in topic_ids or pa.id in group_ids or (pa.id.startswith(NEW_GROUP) and len(pa.id) > len(NEW_GROUP))]
        if not parents:
            continue
        seen.add(name.lower())
        proposed.append(ProposedTopic(name=name, fit=p.fit, parents=parents))
    renames = [r for r in out.renames if r.topic_id in topic_ids and r.new_name.strip()]
    return PlacementOut(existing=list(existing.values()), proposed=proposed[:max_proposed], renames=renames)


# --- offline stand-in --------------------------------------------------------------------------------

# Stand-in vocabulary for new group names (the offline judge cannot invent a subject name).
SUBJECTS = ["Machine Learning", "Deep Learning", "Linear Algebra", "Calculus", "Probability", "Statistics",
            "Databases", "Algorithms", "Data Structures", "Operating Systems", "Computer Networks",
            "Programming", "Physics", "Chemistry", "Biology", "Economics", "History",
            "Natural Language Processing", "Computer Vision", "Optimization", "Discrete Mathematics",
            "Software Engineering", "Computer Architecture", "Information Theory", "Signal Processing"]


class OfflineJudge:
    """Deterministic embedding stand-in for the judge. Not an LLM; see the module docstring."""

    model = "offline-heuristic-v1"

    def __init__(self, cfg: dict, emb: Embedder):
        self.emb = emb
        self.lo, self.hi = cal_bounds(cfg, emb.name)
        self.max_proposed = cfg["judge"]["max_proposed"]
        self.dedup = cfg["scores"]["dedup_threshold"]
        self.option = cfg["embed"]["topic_vector"]

    def fit(self, cos: float) -> int:
        return int(1 + round(4 * float(calibrate(cos, self.lo, self.hi))))

    def _cos(self, a: str, b: str) -> float:
        return float(self.emb.one(a) @ self.emb.one(b))

    def group_fit(self, forest: Forest, text: str, gid: str) -> int:
        """Nearest-neighbour similarity to the group's prompts (its label if it has none), mapped
        coarsely: unrelated subjects get 1, so their pairs fall under tau."""
        members = forest.group_prompts(gid)
        if members:
            cos = float((self.emb.embed([forest.prompts[p].text for p in members]) @ self.emb.one(text)).max())
        else:
            cos = self._cos(text, forest.groups[gid].label)
        cal = float(calibrate(cos, self.lo, self.hi))
        # 0.25 = 10th percentile of a prompt's nearest same-group neighbour (minilm, draft gold labels)
        return 1 if cal < 0.25 else 3 if cal < 0.5 else 4 if cal < 0.75 else 5

    def placement(self, req: PlacementRequest) -> tuple[PlacementOut, JudgeMeta]:
        """Fits are calibrated cosines. Proposals follow the rubric: a topic rated 4 ("a subtopic of
        this that does not exist yet") is the natural parent (fit 5), a topic rated 3 a possible one
        (fit 3); groups by group_fit; a new group (fit 5) only when no group is related."""
        f = req.forest
        existing = [ExistingFit(topic_id=c.id, fit=self.fit(prompt_topic_cosine(self.emb, f, req.text, c.id, self.option)))
                    for c in req.candidates]
        fits = [e.fit for e in existing]
        proposed: list[ProposedTopic] = []
        if not fits or max(fits) < 5 or 4 in fits:
            labels = [t.label for t in f.topics.values()]
            related = sorted((e for e in existing if e.fit >= 3), key=lambda e: -e.fit)[:3]
            gfits = sorted(((g, self.group_fit(f, req.text, g)) for g, _ in req.groups), key=lambda x: -x[1])
            for name in keyphrases(self.emb, [req.text], k=self.max_proposed + 2):
                if labels and max(self._cos(name, lab) for lab in labels) >= self.dedup:
                    continue
                parents = [ParentFit(id=e.topic_id, fit=5 if e.fit >= 4 else 3) for e in related]
                parents += [ParentFit(id=g, fit=fit) for g, fit in gfits[:2]]
                if not gfits or gfits[0][1] == 1:
                    subj = max(SUBJECTS, key=lambda s: self._cos(req.text, s))
                    if subj.lower() not in {lab.lower() for _, lab in req.groups}:
                        parents.append(ParentFit(id=NEW_GROUP + subj, fit=5))
                proposed.append(ProposedTopic(name=name, fit=self.fit(self._cos(req.text, name)), parents=parents))
                if len(proposed) == self.max_proposed:
                    break
        renames: list[Rename] = []
        for c, e in zip(req.candidates, existing):
            members = f.prompts_in(c.id)
            if e.fit < 4 or len(members) < 3:
                continue
            texts = [f.prompts[p].text for p in members] + [req.text]
            new = keyphrases(self.emb, texts, k=1)
            if not new:
                continue
            cen = self.emb.embed(texts).mean(axis=0)
            cen = cen / (np.linalg.norm(cen) or 1)
            old_c = float(self.emb.one(f.topics[c.id].label) @ cen)
            new_c = float(self.emb.one(new[0]) @ cen)
            if new_c - old_c > 0.08 and self._cos(new[0], f.topics[c.id].label) < self.dedup:
                renames.append(Rename(topic_id=c.id, new_name=new[0], fit=self.fit(new_c)))
        return PlacementOut(existing=existing, proposed=proposed, renames=renames), JudgeMeta(model=self.model)

    def neighbourhood(self, req: NeighbourhoodRequest) -> tuple[NeighbourhoodOut, JudgeMeta]:
        prompts = [PromptFit(prompt_id=pid, proposed=name, fit=self.fit(self._cos(text, name)))
                   for name in req.proposed for pid, text in req.prompts]
        f = req.forest
        children = []
        for name in req.proposed:
            for tid, _ in req.topics:
                # cosine is symmetric, so a sibling looks like a child: one level stricter
                fit = self.fit(prompt_topic_cosine(self.emb, f, name, tid, self.option)) - 1
                if fit > 1:
                    children.append(ChildFit(topic_id=tid, proposed=name, fit=fit))
        roots = []
        for g in req.new_groups:
            for tid, _ in req.roots:
                fit = self.fit(prompt_topic_cosine(self.emb, f, g, tid, self.option)) - 1
                if fit > 1:
                    roots.append(RootGroupFit(topic_id=tid, group=g, fit=fit))
        return NeighbourhoodOut(prompts=prompts, children=children, roots=roots), JudgeMeta(model=self.model)

    def restructure(self, forest: Forest) -> tuple[RestructureOut, JudgeMeta]:
        """Average-linkage clustering of the prompts, clusters named by key phrase, grouped by subject."""
        from scipy.cluster.hierarchy import fcluster, linkage

        ids = sorted(forest.prompts, key=lambda p: forest.prompts[p].step)
        if not ids:
            return RestructureOut(groups=[], topics=[]), JudgeMeta(model=self.model)
        X = self.emb.embed([forest.prompts[p].text for p in ids])
        if len(ids) == 1:
            labels = np.array([1])
        else:
            labels = fcluster(linkage(X, method="average", metric="cosine"), t=0.6, criterion="distance")
        topics, groups, used = [], [], set()
        for k in sorted(set(labels)):
            members = [ids[i] for i in range(len(ids)) if labels[i] == k]
            texts = [forest.prompts[p].text for p in members]
            name = (keyphrases(self.emb, texts, k=1) or ["Misc"])[0]
            base, n = name, 2
            while name.lower() in used:
                name, n = f"{base} {n}", n + 1
            used.add(name.lower())
            cen = self.emb.embed(texts).mean(axis=0)
            subj = max(SUBJECTS, key=lambda s: float(self.emb.one(s) @ cen))
            if subj not in groups:
                groups.append(subj)
            topics.append(RestructureTopic(name=name, parent=f"GROUP:{subj}", prompt_ids=members))
        return RestructureOut(groups=groups, topics=topics), JudgeMeta(model=self.model)


# --- live LLM backends -----------------------------------------------------------------------------

class LLMJudge:
    """Claude through the official SDK, structured JSON output, cached, budgeted."""

    def __init__(self, cfg: dict, backend: str, model: str):
        self.cfg = cfg
        self.jcfg = cfg["judge"]
        self.backend = backend
        self.model = model
        self._client = None

    def client(self):
        if self._client is None:
            import anthropic
            from dotenv import load_dotenv

            from . import ROOT
            load_dotenv(ROOT / ".env")
            if self.backend == "proxy":
                base = os.environ.get("PROXY_URL") or "http://127.0.0.1:8790"
                self._client = anthropic.Anthropic(base_url=base.rstrip("/") + "/anthropic", api_key="dummy")
            else:
                self._client = anthropic.Anthropic()
        return self._client

    def _call(self, kind: str, system: str, user: str, out_model: type[BaseModel], repeat: int = 0) -> tuple[BaseModel, JudgeMeta]:
        meta = JudgeMeta(model=self.model)
        k = cache.key("judge", kind, self.backend, self.model, TEMPLATE_VERSION, self.jcfg["effort"], system, user,
                      *([repeat] if repeat else []))
        store = cache.store("judge")
        hit = store.get(k)
        if hit is not None:
            meta.cached = True
            return out_model.model_validate_json(hit), meta
        if cache.REQUIRE_CACHED:
            raise cache.CacheMiss(f"judge {kind} answer not cached for {self.model}")
        schema = _schema(out_model)
        for attempt in range(self.jcfg["retries"] + 1):
            cache.ledger().reserve(self.jcfg["total_max_calls"], self.jcfg["max_calls_per_run"])
            t0 = time.time()
            text, usage, err = self._request(system, user, schema)
            dt = time.time() - t0
            meta.calls += 1
            meta.latency_s += dt
            cache.ledger().add({"kind": kind, "backend": self.backend, "model": self.model, "ok": err is None,
                                "s": round(dt, 2), "in": usage.get("in", 0), "out": usage.get("out", 0), "error": err})
            if err is None:
                try:
                    parsed = out_model.model_validate_json(text)
                    store.put(k, text, kind=kind, model=self.model, template=TEMPLATE_VERSION)
                    return parsed, meta
                except ValidationError as e:
                    err = f"parse: {str(e)[:300]}"
            meta.failures.append(err)
            _log_failure(kind, self.model, err, user)
        raise RuntimeError(f"judge {kind} failed after {self.jcfg['retries'] + 1} attempts: {meta.failures[-1]}")

    def _request(self, system: str, user: str, schema: dict) -> tuple[str, dict, str | None]:
        import anthropic

        output_config = {"effort": self.jcfg["effort"], "format": {"type": "json_schema", "schema": schema}}
        try:
            if self.backend == "anthropic":
                # Server-side fallback on a refusal (Claude 5.x models); see the claude-api notes.
                r = self.client().beta.messages.create(
                    model=self.model, max_tokens=self.jcfg["max_tokens"], system=system,
                    messages=[{"role": "user", "content": user}], output_config=output_config,
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default")
            else:
                r = self.client().messages.create(
                    model=self.model, max_tokens=self.jcfg["max_tokens"], system=system,
                    messages=[{"role": "user", "content": user}], output_config=output_config)
        except anthropic.RateLimitError as e:
            time.sleep(int(e.response.headers.get("retry-after", "20")))
            return "", {}, "rate_limited"
        except anthropic.APIStatusError as e:
            return "", {}, f"http {e.status_code}: {e.message[:200]}"
        except anthropic.APIConnectionError as e:
            return "", {}, f"connection: {e}"
        usage = {"in": getattr(r.usage, "input_tokens", 0) or 0, "out": getattr(r.usage, "output_tokens", 0) or 0}
        if r.stop_reason == "refusal":
            return "", usage, "refusal"
        if r.stop_reason == "max_tokens":
            return "", usage, "max_tokens"
        text = next((b.text for b in r.content if b.type == "text"), "")
        return text, usage, None

    def placement(self, req: PlacementRequest) -> tuple[PlacementOut, JudgeMeta]:
        system = PLACEMENT_SYSTEM.replace("{max_proposed}", str(self.jcfg["max_proposed"]))
        return self._call("placement", system, render_placement(req, self.jcfg["examples_per_topic"]), PlacementOut,
                          repeat=req.repeat)

    def neighbourhood(self, req: NeighbourhoodRequest) -> tuple[NeighbourhoodOut, JudgeMeta]:
        return self._call("neighbourhood", NEIGHBOURHOOD_SYSTEM, render_neighbourhood(req), NeighbourhoodOut)

    def restructure(self, forest: Forest) -> tuple[RestructureOut, JudgeMeta]:
        return self._call("restructure", RESTRUCTURE_SYSTEM, render_restructure(forest), RestructureOut)


def _log_failure(kind: str, model: str, err: str, user: str) -> None:
    path = cache.CACHE / "judge_failures.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": round(time.time()), "kind": kind, "model": model, "error": err,
                            "input": user[:500]}, ensure_ascii=False) + "\n")
