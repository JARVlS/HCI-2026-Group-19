# %% [markdown]
# # 05 Simulation: the IP against simpler methods
#
# **Question.** Over whole sessions, how does the IP compare with the human-made alternatives
# (`chronological`, the chat-sidebar status quo, and `greedy`), with the judge's own top choice
# (`judge_argmax`, `judge_restructure`) and with an IP without stability costs
# (`ip_full_recluster`)? Does the IP ever decide differently from the judge's argmax, i.e. is the
# problem non-trivial?
#
# Every method starts from an empty forest and places the prompts in order. After every step the
# forest is validated and saved to `outputs/forests/<session>/<method>/step_XX.json`.
#
# **Metrics** (`forest/metrics.py`) are the same for every method:
# - **fit** is the calibrated cosine of each prompt to its topic's label, summed. It is one scorer
#   for all methods: no judge scores, and a topic named after its prompts scores higher.
# - **hier fit** is the same cosine between a topic's label and its parent's label.
# - **imbalance** counts topics with more than `U` prompts (`over_U`) or less than `L` content
#   (`under_L`).
# - **disruption** is the prompts and categories moved, removed or renamed, weighted by `w` and
#   `v`.
# - **violations** count breaches of the IP's hard limits (`K_T` trees per group, `K_G` groups).
# - **ari** is the adjusted Rand index of the topic, tree and group partitions against the draft
#   gold labels.
#
# **Caveat.** The judge is the offline stand-in, and the gold labels are drafts.

# %%
import sys
from pathlib import Path

ROOT = Path.cwd().parent if Path.cwd().name == "notebooks" else Path.cwd()
sys.path.insert(0, str(ROOT))

import matplotlib.pyplot as plt
import pandas as pd

from forest import config, viz
from forest.export import export_sequence
from forest.io import SESSION_IDS, load_gold, load_sessions, read_jsonl
from forest.simulate import ALL_METHODS, compare, make_context

viz.style()
pd.set_option("display.width", 200)
cfg = config.load()
ctx = make_context(cfg)
sessions = load_sessions()
golds = {sid: load_gold(sid) for sid in SESSION_IDS}
FIG, MET, FOR = (Path(cfg["paths"][k]) for k in ("figures", "metrics", "forests"))

# %%
all_steps, all_summary, all_forests = [], [], {}
for sid, s in sessions.items():
    steps, summary, forests = compare(list(ALL_METHODS), s, ctx, golds[sid], save_root=FOR)
    all_steps.append(steps)
    all_summary.append(summary)
    all_forests[sid] = forests
steps = pd.concat(all_steps, ignore_index=True)
summary = pd.concat(all_summary, ignore_index=True)
steps.drop(columns=["sizes"]).to_csv(MET / "05_steps.csv", index=False)
summary.to_csv(MET / "05_summary.csv", index=False)
print(f"{len(steps)} steps; every forest validated (run() raises otherwise)")

# %% [markdown]
# ## Comparison per session

# %%
COLS = ["method", "final_fit", "final_hier_fit", "topics", "trees", "groups", "over_U", "under_L",
        "viol_K_T", "viol_K_G", "moved_prompts", "steps_changed", "disruption_w", "ari_topic", "ari_tree",
        "ari_group", "actions"]
for sid in SESSION_IDS:
    print(f"=== {sid}")
    display(summary[summary["session"] == sid][COLS].round(2).set_index("method"))

# %% [markdown]
# ## Is the problem non-trivial?
# `ip_differs_from_judge_argmax` is the share of steps where the IP put the prompt somewhere
# other than the judge's top-rated option, given the same judge answer. It is counterfactual:
# both decisions are compared on the IP's own trajectory.

# %%
nontrivial = summary[summary["method"].isin(["ip", "ip_full_recluster"])][["session", "method", "ip_differs_from_judge_argmax"]]
nontrivial.pivot(index="session", columns="method", values="ip_differs_from_judge_argmax").round(3)

# %% [markdown]
# ## Over the steps

# %%
for sid in SESSION_IDS:
    d = steps[steps["session"] == sid]
    fig, axes = plt.subplots(1, 2, figsize=(12, 3.4))
    viz.line_by_method(d, "fit", axes[0], title=f"{sid}: prompt fit", ylabel="sum of fit over prompts")
    viz.line_by_method(d, "moved_prompts_w", axes[1], title=f"{sid}: cumulative disruption",
                       ylabel="weighted moved prompts (cumulative)", cumulative=True)
    fig.tight_layout()
    viz.save(fig, FIG / f"05_{sid}_fit_disruption.png")

# %%
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
for ax, sid in zip(axes, SESSION_IDS):
    viz.fit_vs_disruption(summary[summary["session"] == sid], ax, title=sid)
    ax.set_xlabel("total weighted disruption")
fig.tight_layout()
viz.save(fig, FIG / "05_fit_vs_disruption.png")

# %% [markdown]
# ## Where the IP and the judge's argmax part ways
# Side by side, after the first steps where the IP's decision differs from the argmax. The forests
# are those of the two methods' own runs, so they also differ by everything that happened before.

# %%
for sid in ["s1_focused", "s2_mixed"]:
    d = steps[(steps["session"] == sid) & (steps["method"] == "ip")]
    diff_steps = d[d["same_as_argmax"] == False]["step"].tolist()  # noqa: E712
    picks = diff_steps[1:3] if len(diff_steps) > 2 else diff_steps[:2]
    for st in picks:
        fig, axes = plt.subplots(1, 2, figsize=(14, 4.2))
        for ax, m in zip(axes, ["ip", "judge_argmax"]):
            f = all_forests[sid][m][st - 1]
            prev = all_forests[sid][m][st - 2]
            row = steps[(steps["session"] == sid) & (steps["method"] == m) & (steps["step"] == st)].iloc[0]
            viz.plot_forest(f, ax, title=f"{sid} step {st}, {m}: {row['action']}", **viz.forest_change_sets(prev, f))
        viz.save(fig, FIG / f"05_{sid}_step{st:02d}_ip_vs_argmax.png")
        plt.show()

# %% [markdown]
# ## Export for the prototype
# The forest after every step of every method, in the app's data model (concepts, trees, attempts,
# messages; see `forest/export.py`), plus each step's decision. The A/B condition of Milestone 4
# loads `outputs/forests/<session>/ip/app_sequence.json`.

# %%
for sid in SESSION_IDS:
    for m in ALL_METHODS:
        out = FOR / sid / m
        decisions = read_jsonl(out / "decisions.jsonl")
        export_sequence(all_forests[sid][m], decisions, out, {"session": sid, "method": m, "judge": ctx.judge.model,
                                                              "embedding": ctx.emb.model})
print("exported", sorted(p.relative_to(ROOT).as_posix() for p in FOR.glob("*/ip/app_*.json")))

# %% [markdown]
# ## Numbers for the findings

# %%
key = summary.set_index(["session", "method"])
for sid in SESSION_IDS:
    k = key.loc[sid]
    print(f"{sid}: ip fit {k.loc['ip', 'final_fit']:.1f} vs argmax {k.loc['judge_argmax', 'final_fit']:.1f} vs "
          f"greedy {k.loc['greedy', 'final_fit']:.1f} vs chronological {k.loc['chronological', 'final_fit']:.1f}; "
          f"topics ip {k.loc['ip', 'topics']} argmax {k.loc['judge_argmax', 'topics']}; "
          f"K_T violations greedy {k.loc['greedy', 'viol_K_T']} argmax {k.loc['judge_argmax', 'viol_K_T']}; "
          f"disruption ip {k.loc['ip', 'disruption_w']:.1f} full {k.loc['ip_full_recluster', 'disruption_w']:.1f} "
          f"restructure {k.loc['judge_restructure', 'disruption_w']:.1f}; "
          f"differs {k.loc['ip', 'ip_differs_from_judge_argmax']:.2f}")

# %% [markdown]
# ## Findings
#
# - All six methods ran on all three sessions, and every one of the 510 forests validated.
# - **Non-trivial:** given the same judge answer, the IP placed the prompt elsewhere than the
#   judge's argmax in 47 %, 60 % and 80 % of the steps (s1, s2, s3). The IP without stability
#   costs did so in 23 to 40 %.
# - **Fit:** on the shared label-cosine fit, the IP scores below the judge-based baselines
#   (s1 23.7 vs 28.8 for `judge_argmax`, s2 19.0 vs 28.4, s3 16.2 vs 24.0) but far above the
#   chat-sidebar status quo (`chronological`: 8.4, 5.3, 7.3). It also builds far fewer topics
#   (15, 12, 10 vs 21, 26, 19). This metric rewards many topics named after their own prompts,
#   which the IP prices with `lam` and `L`.
# - **Structure and stability:** the IP never breaks the tree limit `K_T`, while `greedy` and
#   `judge_argmax` exceed it by 5 to 12 trees per session and leave 6 to 18 topics below `L`. The
#   IP moved at most 2 old prompts per session (weighted disruption 0 to 3.1). The IP without
#   stability costs moved 18 to 42 (78 to 182), and the periodic judge restructure up to 21 (24 to 67).
# - **Gold agreement (draft labels):** mixed. Topic ARI for the IP is 0.30, 0.32 and 0.06, against
#   0.30, 0.19 and 0.44 for `judge_argmax`. The drifting session is the IP's weak case with the
#   stand-in judge.
# - *Caveat:* offline stand-in judge, draft gold labels. Re-run with a live judge before quoting
#   any of this. The group's interpretation goes here.
