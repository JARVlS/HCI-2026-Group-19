"""The judge scores options and proposes changes; it never decides (plan Section 3).

Output (validated with Pydantic): fits of the new prompt to every existing topic, up to 2 proposed
topics with rated parents, and up to 6 proposed moves of old prompts or topics. Fits use the scale
5 exactly right, 4 right area but a more specific topic would be better, 3 same broader area,
2 loosely related, 1 unrelated.

Two backends with the same call, judge(forest, prompt, step):
  OracleJudge  derives every score from the ideal forest (no API calls; tests and sweeps)
  LLMJudge     a model with the JSON schema enforced, cached to disk: Claude through the Claude Code
               CLI on your Claude subscription (provider claude-cli, no key), or any
               chat-completions endpoint (provider openai, key in .env)
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ValidationError, model_validator

from . import ROOT
from .model import Forest, Ideal, Prompt

NEW_GROUP = "NEW_GROUP:"
Fit = Literal[1, 2, 3, 4, 5]


class ExistingFit(BaseModel):
    topic_id: str
    fit: Fit


class ParentFit(BaseModel):
    parent: str   # existing topic id, existing group id, NEW_GROUP:<name>, or the other proposed topic's name
    fit: Fit


class Proposed(BaseModel):
    name: str
    fit: Fit
    parents: list[ParentFit]


class Move(BaseModel):
    kind: Literal["prompt", "topic"]
    id: str
    to: str       # existing topic id, proposed topic name, existing group id or NEW_GROUP:<name>
    fit: Fit


class JudgeOutput(BaseModel):
    existing: list[ExistingFit]
    proposed: list[Proposed]
    restructure: list[Move]

    @model_validator(mode="after")
    def _caps(self) -> "JudgeOutput":
        self.proposed = self.proposed[:2]
        self.restructure = self.restructure[:6]
        return self


def rescale(fit: int) -> float:
    return (fit - 1) / 4


# --- oracle --------------------------------------------------------------------------------------

class OracleJudge:
    """Scores from the ideal forest (plan Section 3.3). Current topics and groups are matched to
    ideal ones by label. With probability `noise`, every fit is shifted by +1 or -1 (clipped)."""

    def __init__(self, ideal: Ideal, noise: float = 0.0, seed: int = 42):
        self.ideal, self.noise, self.seed = ideal, noise, seed
        self.name = f"oracle(noise={noise})"
        F = ideal.forest
        self.ideal_by_label = {t.label.lower(): t.id for t in F.topics.values()}

    def __call__(self, forest: Forest, n: Prompt, step: int) -> JudgeOutput:
        F, rng = self.ideal.forest, random.Random(f"{self.seed}:{step}:{n.id}")
        T = self.ideal.topic_of(n.id)
        cur = {t.label.lower(): t.id for t in forest.topics.values()}
        cur_groups = {g.label.lower(): g.id for g in forest.groups.values()}

        def ideal_of(topic_id: str) -> str | None:
            return self.ideal_by_label.get(forest.topics[topic_id].label.lower())

        def fit_to(I: str | None) -> int:
            if I is None:
                return 1
            if I == T:
                return 5
            if T in F.subtree(I):
                return 4
            if F.root_of(I) == F.root_of(T):
                return 3
            return 2 if F.group_of(I) == F.group_of(T) else 1

        existing = [ExistingFit(topic_id=c, fit=fit_to(ideal_of(c))) for c in forest.topics]

        # proposals: the missing part of the ideal chain above T, closest to the existing forest first
        proposed: list[Proposed] = []
        if F.topics[T].label.lower() not in cur:
            chain = [T] + F.ancestors(T)                       # T up to its ideal tree root
            k = next((i for i, c in enumerate(chain) if F.topics[c].label.lower() in cur), len(chain))
            missing = chain[:k][::-1]                          # top-down
            if k < len(chain):
                base = cur[F.topics[chain[k]].label.lower()]
            else:
                glabel = F.groups[F.group_of(T)].label
                base = cur_groups.get(glabel.lower(), NEW_GROUP + glabel)
            for i, m in enumerate(missing[:2]):
                parents = [ParentFit(parent=base, fit=5)] if i == 0 else [ParentFit(parent=F.topics[missing[0]].label, fit=5)]
                if i == 1 and m == T:
                    parents.append(ParentFit(parent=base, fit=4))  # T directly under its nearest existing ancestor
                proposed.append(Proposed(name=F.topics[m].label, fit=5 if m == T else 4, parents=parents))
        names = {p.name.lower(): p.name for p in proposed}
        proposed_groups = {pa.parent for p in proposed for pa in p.parents if pa.parent.startswith(NEW_GROUP)}

        def ref(I: str) -> str | None:
            """Where the ideal topic I is in the current forest or the proposals."""
            label = F.topics[I].label.lower()
            return cur.get(label) or names.get(label)

        moves: list[Move] = []
        for c, t in forest.topics.items():
            I = ideal_of(c)
            if I is None:
                continue
            ip = F.topics[I]
            if ip.parent_kind == "topic":
                target = ref(ip.parent)
                here = t.parent_kind == "topic" and forest.topics[t.parent].label.lower() == F.topics[ip.parent].label.lower()
            else:
                glabel = F.groups[ip.parent].label
                target = cur_groups.get(glabel.lower()) or (NEW_GROUP + glabel if NEW_GROUP + glabel in proposed_groups else None)
                here = t.parent_kind == "group" and forest.groups[t.parent].label.lower() == glabel.lower()
            if target and not here:
                moves.append(Move(kind="topic", id=c, to=target, fit=5))
        for p in sorted(forest.placement, key=lambda p: forest.placement[p].created):
            Tp = self.ideal.topic_of(p)
            target = ref(Tp)
            if target and forest.topics[forest.placement[p].topic].label.lower() != F.topics[Tp].label.lower():
                moves.append(Move(kind="prompt", id=p, to=target, fit=5))

        out = JudgeOutput(existing=existing, proposed=proposed, restructure=moves)
        return self._noisy(out, rng) if self.noise else out

    def _noisy(self, out: JudgeOutput, rng: random.Random) -> JudgeOutput:
        def j(fit: int) -> int:
            return min(5, max(1, fit + rng.choice((-1, 1)))) if rng.random() < self.noise else fit
        for e in out.existing:
            e.fit = j(e.fit)
        for p in out.proposed:
            p.fit = j(p.fit)
            for pa in p.parents:
                pa.fit = j(pa.fit)
        for m in out.restructure:
            m.fit = j(m.fit)
        return out


# --- LLM -----------------------------------------------------------------------------------------

SYSTEM = """You help organise the questions a student asks a tutor into a knowledge forest. Groups
(subjects) hold trees of topics, at most 3 levels deep; every question sits in exactly one topic.
You do NOT decide anything. You score options and propose changes; an optimiser decides.

Fit scale (use exactly these integers): 5 = exactly right; 4 = right area, a more specific topic
would be better; 3 = same broader area; 2 = loosely related; 1 = unrelated.

Return one JSON object with:
1. existing: the fit of the new question to EVERY existing topic.
2. proposed: up to 2 new topics (short names, 1 to 4 words, a concept a student would look for).
   Give the new question's fit to each, and rate possible parents: an existing topic id, an
   existing group id (a new tree), NEW_GROUP:<subject name> (a new group), or the name of the
   other proposed topic.
3. restructure: up to 6 moves that would make the forest better organised: {kind: "prompt", id,
   to} moves an old question to an existing or proposed topic; {kind: "topic", id, to} moves an
   existing topic under an existing topic, a proposed topic, an existing group or NEW_GROUP:<name>.
   Rate each move with the same scale. An empty list is fine."""


def render(forest: Forest, n: Prompt, seed: int, step: int) -> str:
    """The new prompt and the full forest, topics in an order shuffled with a fixed seed."""
    topics = list(forest.topics)
    random.Random(f"{seed}:{step}").shuffle(topics)
    lines = [f"New question ({n.id}): {json.dumps(n.text, ensure_ascii=False)}", "", "Groups (id | name):"]
    lines += [f"- {g.id} | {g.label}" for g in forest.groups.values()] or ["(none yet)"]
    lines += ["", "Topics (id | path | questions in it):"]
    for t in topics:
        qs = " ; ".join(f"{p}: {json.dumps(forest.prompts[p].text, ensure_ascii=False)}" for p in forest.prompts_in(t))
        lines.append(f"- {t} | {forest.path(t)} | {qs or '(only subtopics)'}")
    if not topics:
        lines.append("(none yet)")
    return "\n".join(lines)


def schema() -> dict:
    """JSON schema of JudgeOutput for strict structured output: refs inlined, objects closed."""
    raw = JudgeOutput.model_json_schema()
    defs = raw.pop("$defs", {})

    def fix(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return fix(defs[node["$ref"].split("/")[-1]])
            node = {k: fix(v) for k, v in node.items() if k not in ("title", "default")}
            if node.get("type") == "object":
                node["additionalProperties"] = False
                node["required"] = list(node.get("properties", {}))
            return node
        return [fix(x) for x in node] if isinstance(node, list) else node

    return fix(raw)


class CacheMiss(RuntimeError):
    pass


def claude_bin(cfg: dict | None = None) -> str | None:
    """The Claude Code CLI: config llm.claude_bin, else `claude` on PATH, else the newest copy bundled
    with the VS Code (or Cursor) extension."""
    if cfg and cfg.get("claude_bin"):
        return cfg["claude_bin"]
    found = shutil.which("claude")
    if found:
        return found
    bundled = [p for ext in (".vscode", ".cursor")
               for p in (Path.home() / ext / "extensions").glob("anthropic.claude-code-*/resources/native-binary/claude")]
    return str(max(bundled, key=lambda p: p.stat().st_mtime)) if bundled else None


class LLMJudge:
    """A model (config `llm`), JSON schema enforced, one retry on a parse failure. Every answer is
    cached in data/cache/llm.jsonl (git-ignored), keyed by a hash of (model, template version,
    input); data/llm_answers.jsonl is the committed copy (freeze()).

    provider claude-cli: `claude -p` on the logged-in Claude subscription (an API key in the
      environment is removed, so it is never billed to an API account). Safe mode, no tools, our
      system prompt only, run in an empty folder: the model sees nothing but the forest. The CLI
      has no temperature setting; the cache makes reruns reproducible.
    provider openai: any chat-completions endpoint (base_url, key LLM_API_KEY), temperature 0."""

    CACHE = ROOT / "data" / "cache" / "llm.jsonl"
    FROZEN = ROOT / "data" / "llm_answers.jsonl"

    def __init__(self, cfg: dict, cached_only: bool = False):
        self.cfg, self.seed = cfg["llm"], cfg["seed"]
        self.model = self.cfg["model"]
        self.provider = self.cfg.get("provider") or "openai"
        self.name = f"llm({self.model})"
        self.cached_only = cached_only   # True: never call the API (submission notebook)
        self.calls = 0
        self.model_id: str | None = None  # the exact model that answered last (for the citation)
        self.answers: dict[str, str] = {}
        for path in (self.FROZEN, self.CACHE):
            if path.exists():
                for line in path.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        row = json.loads(line)
                        self.answers[row["key"]] = row["answer"]
        self._client = None

    @property
    def available(self) -> bool:
        """Configured (model set) or answering from the cache only."""
        if not self.model:
            return False
        if self.cached_only:
            return True
        if self.provider == "claude-cli":
            return claude_bin(self.cfg) is not None
        return bool(self._key()) or self._local()

    def _key(self) -> str:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
        return os.environ.get("LLM_API_KEY", "")

    def _local(self) -> bool:
        return bool(self.cfg["base_url"]) and ("localhost" in self.cfg["base_url"] or "127.0.0.1" in self.cfg["base_url"])

    def client(self):
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(base_url=self.cfg["base_url"], api_key=self._key() or "none")
        return self._client

    def __call__(self, forest: Forest, n: Prompt, step: int) -> JudgeOutput:
        user = render(forest, n, self.seed, step)
        key = hashlib.sha256(json.dumps([self.model, self.cfg["template_version"], SYSTEM, user]).encode()).hexdigest()
        if key in self.answers:
            return JudgeOutput.model_validate_json(self.answers[key])
        if self.cached_only:
            raise CacheMiss(f"no cached LLM answer for step {step} ({n.id})")
        last = None
        for attempt in range(2):                       # one retry on a parse failure
            text = self._ask(user)
            try:
                out = JudgeOutput.model_validate_json(text)
            except ValidationError as e:
                last = e
                continue
            self.answers[key] = text
            self.CACHE.parent.mkdir(parents=True, exist_ok=True)
            with self.CACHE.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"key": key, "model": self.model, "model_id": self.model_id or self.model,
                                    "step": step, "prompt": n.id, "answer": text}) + "\n")
            return out
        raise RuntimeError(f"LLM answer did not parse twice: {last}")

    def _ask(self, user: str) -> str:
        if self.provider == "claude-cli":
            return self._ask_claude(user)
        import openai
        self.calls += 1
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
        fmt = {"type": "json_schema", "json_schema": {"name": "judge", "schema": schema(), "strict": True}}
        try:
            r = self.client().chat.completions.create(model=self.model, messages=msgs, temperature=0,
                                                      seed=self.seed, response_format=fmt)
        except openai.BadRequestError:
            # endpoint without json_schema support: the schema goes into the prompt instead
            msgs[0]["content"] += "\n\nAnswer with JSON only, matching this schema:\n" + json.dumps(schema())
            r = self.client().chat.completions.create(model=self.model, messages=msgs, temperature=0, seed=self.seed)
        self.model_id = getattr(r, "model", None) or self.model
        text = (r.choices[0].message.content or "").strip()
        return text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    def _ask_claude(self, user: str) -> str:
        exe = claude_bin(self.cfg)
        if exe is None:
            raise RuntimeError("Claude Code CLI not found: install it or set llm.claude_bin in config.yaml")
        self.calls += 1
        # the subscription login, never an API key; no ties to a Claude Code session this runs inside
        env = {k: v for k, v in os.environ.items()
               if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT")
               and not k.startswith(("CLAUDE_CODE_", "CLAUDE_AGENT_SDK"))}
        cmd = [exe, "-p", "--model", self.model, "--safe-mode", "--tools", "", "--no-session-persistence",
               "--system-prompt", SYSTEM, "--output-format", "json", "--json-schema", json.dumps(schema())]
        with tempfile.TemporaryDirectory() as empty:
            r = subprocess.run(cmd, input=user, capture_output=True, text=True, cwd=empty, env=env, timeout=600)
        try:
            data = json.loads(r.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"claude CLI failed (exit {r.returncode}): {(r.stderr or r.stdout)[:500]}") from None
        if data.get("is_error"):
            raise RuntimeError(f"claude CLI error: {data.get('result') or data.get('subtype')}")
        self.model_id = next(iter(data.get("modelUsage") or {}), self.model)
        out = data.get("structured_output")
        return json.dumps(out) if out is not None else (data.get("result") or "").strip()

    @classmethod
    def freeze(cls) -> int:
        """Copy every cached answer to data/llm_answers.jsonl (committed), so the submission runs
        without a key."""
        rows: dict[str, str] = {}
        for path in (cls.FROZEN, cls.CACHE):
            if path.exists():
                for line in path.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        rows[json.loads(line)["key"]] = line
        cls.FROZEN.write_text("\n".join(rows.values()) + ("\n" if rows else ""), encoding="utf-8")
        return len(rows)
