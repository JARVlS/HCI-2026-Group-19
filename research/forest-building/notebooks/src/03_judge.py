# %% [markdown]
# # 03 The judge
#
# **Question.** Which judge model agrees best with the gold labels, how position-biased and
# consistent is it, how often does its output fail to parse, and what does it cost?
#
# **What runs here today.** No model provider key was available when this was built, so the only
# judge that runs is the **offline stand-in** (`offline-heuristic-v1`). It is not an LLM: its fits
# are calibrated cosines, its topic names are key phrases, and its new groups come from a fixed
# list of subjects. Its numbers are a floor for the pipeline, **not judge results**. The live
# comparison below is switched off (`RUN_LIVE = False`). Switch it on once the group has chosen a
# provider and a budget (plan §6, §7.1); it then runs every model in `judge.compare` in the config
# through the cost guard.
#
# Settings follow the plan: candidates in shuffled order with a fixed seed, a JSON schema enforced
# through structured output, one retry on a parse failure, every failure logged to
# `data/cache/judge_failures.jsonl`. **Temperature 0 is not possible on current Claude models.** The
# API rejects `temperature`, so determinism is measured (consistency below), not set.

# %%
import os
import sys
from pathlib import Path

ROOT = Path.cwd().parent if Path.cwd().name == "notebooks" else Path.cwd()
sys.path.insert(0, str(ROOT))

import pandas as pd

from forest import config
from forest.embed import Embedder
from forest.evaluate import (consistency, judge_agreement, position_bias, validation_sample, weighted_kappa)
from forest.io import SESSION_IDS, gold_forest, load_gold, load_sessions
from forest.judge import (PLACEMENT_SYSTEM, TEMPLATE_VERSION, Candidate, Judge, PlacementRequest, render_placement)

cfg = config.load()
sessions = load_sessions()
golds = {sid: load_gold(sid) for sid in SESSION_IDS}
emb = Embedder(cfg)
RUN_LIVE = False   # True only after the group agreed on provider and budget
print("template version:", TEMPLATE_VERSION)
print("credentials present:", {k: bool(os.environ.get(k)) for k in ("ANTHROPIC_API_KEY", "PROXY_URL")})

# %% [markdown]
# ## The placement prompt, as the model sees it
# For review by the group: the system prompt and the user message for prompt 12 of `s1_focused`,
# placed against the gold forest of prompts 1 to 11.

# %%
s = sessions["s1_focused"]
p = s.prompts[11]
f = gold_forest(s, golds["s1_focused"], p.step)
cands = [Candidate(c, f.path(c), [f.prompts[x].text for x in f.prompts_in(c)[-3:]]) for c in sorted(f.topics)]
req = PlacementRequest(p.id, p.text, cands, [(g, grp.label) for g, grp in f.groups.items()], f, cfg["seed"])
print(PLACEMENT_SYSTEM.replace("{max_proposed}", str(cfg["judge"]["max_proposed"])))
print("\n=== user message ===\n")
print(render_placement(req, cfg["judge"]["examples_per_topic"]))

# %% [markdown]
# ## Agreement with the gold labels
# The gold forest is replayed, and the judge rates every gold topic, as in the pipeline. Top-1 accuracy
# counts the prompts whose gold topic already exists. When the gold topic is new, we check
# whether the judge proposes a new topic at all.

# %%
def evaluate(judge: Judge) -> dict:
    runs = {sid: judge_agreement(judge, s, golds[sid], order_seed=cfg["seed"]) for sid, s in sessions.items()}
    df = pd.concat(runs.values(), ignore_index=True)
    ok = df[df["error"].isna()]
    exists = ok[ok["gold_exists"]]
    new = ok[~ok["gold_exists"]]
    bias = pd.Series({sid: position_bias(judge, s, golds[sid], seeds=(cfg["seed"], cfg["seed"] + 1))
                      for sid, s in sessions.items()}).mean()
    again = pd.concat([judge_agreement(judge, s, golds[sid], order_seed=cfg["seed"], repeat=1)
                       for sid, s in sessions.items()], ignore_index=True)
    return {
        "model": judge.model, "prompts": len(df),
        "top1_accuracy": exists["top1_hit"].mean(),
        "gold_topic_fit_mean": exists["gold_fit"].mean(),
        "proposes_when_gold_new": (new["n_proposed"] > 0).mean() if len(new) else float("nan"),
        "position_bias": bias, "consistency": consistency(df, again),
        "parse_failure_rate": df["error"].notna().mean(),
        "latency_s_mean": df["latency_s"].mean(), "live_calls": int(df["calls"].sum() + again["calls"].sum()),
    }, df

offline_row, offline_df = evaluate(Judge(cfg, emb))
pd.DataFrame([offline_row]).round(3)

# %% [markdown]
# ## Live models (switched off)
# With `RUN_LIVE = True`, each model in `judge.compare` runs the same evaluation: 3 live calls per
# prompt (the first candidate order, a second order for position bias, a repeat of the first for
# consistency), so about 255 calls per model for the 85 prompts. The cost guard stops before the
# first call if that exceeds `judge.max_calls_per_run`, and the ledger refuses any call beyond
# `judge.total_max_calls`. Answers are cached, so a re-run is free.

# %%
rows = [offline_row]
if RUN_LIVE:
    from forest.cache import ledger
    for spec in cfg["judge"]["compare"]:
        j = Judge(cfg, emb, backend=spec["backend"], model=spec["model"])
        est = 3 * sum(len(s.prompts) for s in sessions.values())
        print(f"{spec['model']}: at most {est} live calls; ledger so far {ledger().calls}")
        if est > cfg["judge"]["max_calls_per_run"]:
            raise RuntimeError(f"{est} calls exceed judge.max_calls_per_run; raise it in the config if the group agrees")
        ledger().run_calls = 0  # each model is one run for the cost guard
        row, _ = evaluate(j)
        rows.append(row)
else:
    print("live comparison skipped (RUN_LIVE = False). Candidates in config:",
          [f"{c['backend']}/{c['model']}" for c in cfg["judge"]["compare"]])
comparison = pd.DataFrame(rows).round(3)
comparison.to_csv(Path(cfg["paths"]["metrics"]) / "judge_comparison.csv", index=False)
comparison

# %% [markdown]
# ## Where the offline stand-in goes wrong
# Prompts whose gold topic exists but was not rated highest. These show the limits of a
# cosine-only judge, and they are the cases to check first once a live model has run.

# %%
miss = offline_df[offline_df["gold_exists"] & ~offline_df["top1_hit"].astype(bool)]
gap = (miss["max_fit"] - miss["gold_fit"])
print(f"{len(miss)} misses of {int(offline_df['gold_exists'].sum())}: gold topic tied with the top fit in {int((gap == 0).sum())}, "
      f"one point below in {int((gap == 1).sum())}, further below in {int((gap > 1).sum())}")
pd.DataFrame({"prompt": miss["prompt"], "gold fit": miss["gold_fit"], "best fit": miss["max_fit"],
              "top-1 topic": miss["top1"]}).head(12)

# %% [markdown]
# ## Human validation sample
# 40 random (prompt, topic) pairs with the judge's score hidden, for two group members to rate on
# the same 1 to 5 scale (`data/gold/judge_validation.csv`). Once both rating columns are filled in,
# this cell reports the weighted Cohen's kappa between the raters, and between the judge and their
# mean rating.

# %%
path = ROOT / "data" / "gold" / "judge_validation.csv"
if not path.exists():
    validation_sample({sid: (sessions[sid], golds[sid]) for sid in SESSION_IDS}, 40, cfg["seed"]).to_csv(path, index=False)
    print("wrote", path.relative_to(ROOT))
val = pd.read_csv(path, dtype=str).fillna("")
filled = val[(val["rating_rater1"] != "") & (val["rating_rater2"] != "")]
print(f"{len(filled)} of {len(val)} pairs rated by both raters")
if len(filled) >= 10:
    r1 = filled["rating_rater1"].astype(int).tolist()
    r2 = filled["rating_rater2"].astype(int).tolist()
    print("weighted kappa rater1 vs rater2:", round(weighted_kappa(r1, r2), 3))

# %% [markdown]
# ## Findings
#
# - Only the offline stand-in ran. It parses every answer (it builds its output in code), is
#   deterministic (consistency 1.0) and does not depend on candidate order (position bias 0). Those
#   three numbers say nothing about an LLM judge.
# - Its top-1 agreement with the draft gold labels is 0.737 on the 57 prompts whose gold topic
#   exists. It proposes a new topic for 96 % of the prompts whose gold topic is new. These are the
#   floor a live judge has to beat. 9 of its 15 misses are ties on the coarse 1 to 5 scale, and 5
#   are one point below the top. This is one reason the IP mixes in the cosine (`gamma` = 0.7).
# - The plan's check ("the chosen model parses 100 % of cached calls for one full session") is
#   **open**. It needs `RUN_LIVE = True` with a provider the group picks. Candidate model ids are in
#   the config (`judge.compare`), ready for the citation in the report.
# - The validation sample is written. Its kappa waits for two raters.
