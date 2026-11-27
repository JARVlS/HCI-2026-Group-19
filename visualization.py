"""Figures and tables for ui_optimization.ipynb (HCI 2026, Group 19, Milestone 3).

A forest is a *state* and a session a *history* (see forest.py):
    state   = {"groups", "topics", "assign"}
    history = [{"k", "step", "before", "after", "action", "parts", "params"}, ...]   (run_session in the notebook)

Figures
    draw_tree(state, ax, ...)          one forest (all groups side by side) on a matplotlib axis
    show_session(history)              one tree per step (grid)
    show_step(history, k)              one step, before and after
    show_final_trees(histories)        final forests of several designs (2 per row)
    animate_step(history, k)           one step as an animation
    animate_session(history)           the whole session as an animation
Tables
    question_table()                   the questions of the session
    proposal_tables(s)                 the LLM's proposals and the fits s(p, c)
    step_table(history, s, lookup)     what happened in every step
    outcome_table(histories)           the outcome (a)-(e) of every step, per design
"""
import textwrap

import numpy as np
import matplotlib.pyplot as plt
from matplotlib import animation
from matplotlib.lines import Line2D
from matplotlib.patches import FancyArrowPatch
import pandas as pd
from IPython.display import HTML, display

import forest
from session import SESSION, INITIAL_GROUPS, all_prompts

COL = {"new": "#2a78d6", "moved": "#eb6834", "old": "#b8b7b2", "ink": "#0b0b0b",
       "muted": "#52514e", "wood": "#8c8579", "warn": "#e34948"}
FONT = dict(family="monospace")
X, V, DOT = 2.6, 1.7, 0.17          # horizontal / vertical spacing of the tree, spacing of prompt dots
WRAP = 12                           # topic labels are wrapped after this many characters (whole words)

plt.rcParams["animation.embed_limit"] = 60   # MB, allows embedding the session animation


GROUP_GAP = 0.6                     # extra horizontal space between two groups


# ------------------------------------------------------------------ layout
def _children(state, node):
    return [c for c, t in state["topics"].items() if t["parent"] == node]


def _members(state, c):
    return [p for p, t in state["assign"].items() if t == c]


def geometry(state):
    """Positions of every node (groups and topics) and of every prompt dot.

    Tidy layout: the groups stand side by side on the ground, leaves get consecutive x positions, a parent
    sits above the middle of its children, depth grows upwards.
    """
    pos, nxt = {}, [0.0]

    def place(node, depth):
        kids = _children(state, node)
        for k in kids:
            place(k, depth + 1)
        if kids:
            pos[node] = (np.mean([pos[k][0] for k in kids]), depth)
        else:
            pos[node] = (nxt[0], depth)
            nxt[0] += 1

    for g in state["groups"]:
        place(g, 0)
        nxt[0] += GROUP_GAP
    node = {c: np.array([x * X, d * V]) for c, (x, d) in pos.items()}
    dots = {}
    for c in state["topics"]:
        ms = _members(state, c)
        for i, p in enumerate(ms):
            dots[p] = node[c] + np.array([(i - (len(ms) - 1) / 2) * DOT, 0.3])
    return node, dots


def _label(text):
    """A topic label wrapped onto short lines, and how many lines it has."""
    lines = textwrap.wrap(text, WRAP, break_long_words=False) or [""]
    return "\n".join(lines), len(lines)


def _size_note(k):
    """'3 prompts'"""
    return f"{k} prompt{'s' if k != 1 else ''}", COL["muted"]


def _font_size(state, node, ax):
    """Topic labels as large as possible (at most 8.5 pt) without overlapping their neighbours."""
    width_pt = ax.get_position().width * ax.figure.get_figwidth() * 72
    xs = [v[0] for v in node.values()]
    pt_per_unit = width_pt / (max(xs) - min(xs) + 2.6)
    longest = max((len(line) for t in state["topics"].values() for line in _label(t["label"])[0].split("\n")),
                  default=1)
    return float(np.clip(0.95 * X * pt_per_unit / (0.6 * longest), 6.5, 8.5))


def step_title(h, width=42):
    text = textwrap.shorten(h["step"]["text"], width, placeholder="…")
    return f'Step {h["k"]}: "{text}"\n{h["action"]}'


def legend(fig, y=-0.02, moves=True):
    keys = ("new", "moved", "old")
    labels = ["prompt asked in this step", "old prompt moved in this step", "unchanged prompt"]
    handles = [Line2D([], [], marker="o", ls="", ms=8, color=COL[k]) for k in keys]
    if moves:
        handles.append(Line2D([], [], color=COL["moved"], ls="--"))
        labels.append("new topic (dashed box) / move")
    fig.legend(handles, labels, loc="lower center", ncol=len(handles), frameon=False, fontsize=9,
               bbox_to_anchor=(0.5, y))


# ------------------------------------------------------------------ static trees
def draw_tree(state, ax, title="", prev=None, new_prompt=None):
    """Draw the forest like the prototype's tree view: one tree per group, the group name on the ground.

    prev:       state before the step; marks moved prompts, new topics and a new group
    new_prompt: id of the prompt asked in this step (blue)
    """
    groups, topics = state["groups"], state["topics"]
    node, dots = geometry(state)
    fs = _font_size(state, node, ax)

    def load(c):  # prompts in the subtree of c: the wood gets thicker towards the root
        return len(_members(state, c)) + sum(load(k) for k in _children(state, c))

    for c in node:                                   # wood
        for k in _children(state, c):
            (x0, y0), (x1, y1) = node[c], node[k]
            ax.plot([x0, x1], [y0 + (0.0 if c in groups else 0.5), y1 - 0.45], color=COL["wood"],
                    lw=1.0 + 0.9 * np.sqrt(load(k)), solid_capstyle="round", zorder=1)

    xs = [v[0] for v in node.values()]
    ax.plot([min(xs) - 0.6, max(xs) + 0.6], [-0.05] * 2, color=COL["wood"], lw=1, ls=(0, (1, 3)))
    for g, label in groups.items():                  # the groups below the ground line
        is_new = prev is not None and g not in prev["groups"]
        box = dict(boxstyle="round,pad=0.25", fc="white", ec=COL["moved"], ls="--", lw=1.2) if is_new else None
        ax.text(node[g][0], -0.32, label, ha="center", va="center", weight="bold", fontsize=9.5, bbox=box, **FONT)

    for c, (x, y) in node.items():                   # topics and their prompts
        if c in groups:
            continue
        is_new = prev is not None and c not in prev["topics"]
        box = dict(boxstyle="round,pad=0.3", fc="white", ec=COL["moved"] if is_new else "none",
                   ls="--" if is_new else "-", lw=1.2)
        text, lines = _label(topics[c]["label"])
        ax.text(x, y, text, ha="center", va="center", fontsize=fs, zorder=4, bbox=box, linespacing=1.0, **FONT)
        for p in _members(state, c):
            moved = prev is not None and p in prev["assign"] and prev["assign"][p] != c
            kind = "new" if p == new_prompt else ("moved" if moved else "old")
            ax.scatter(*dots[p], s=55, color=COL[kind], edgecolors="white", linewidths=1.2, zorder=5)
        note, color = _size_note(len(_members(state, c)))
        ax.text(x, y - 0.27 - 0.07 * (lines - 1), note, ha="center", va="center", fontsize=fs - 1.5, color=color,
                zorder=4, **FONT)

    if prev is not None:                             # moves: dashed arrow from the old topic
        for p, c1 in state["assign"].items():
            c0 = prev["assign"].get(p)
            if c0 and c0 != c1 and c0 in node:       # (no arrow from a topic deleted in this step)
                w0 = len(_members(state, c0)) * DOT / 2 + 0.15
                w1 = len(_members(state, c1)) * DOT / 2 + 0.15
                (x0, y0), (x1, y1) = node[c0], node[c1]
                ax.add_patch(FancyArrowPatch((x0 + w0, y0 + 0.3), (x1 + w1, y1 + 0.3),
                                             connectionstyle="arc3,rad=0.45", arrowstyle="-|>", mutation_scale=10,
                                             color=COL["moved"], lw=1, ls="--", zorder=3))
    ax.set_xlim(min(xs) - 1.3, max(xs) + 1.3)
    ax.set_ylim(-0.7, max(v[1] for v in node.values()) + 0.6)
    ax.axis("off")
    ax.set_title(title, loc="left", fontsize=9.5)


def show_session(history, title=None, cols=2):
    """One tree per step, starting with the tree before the session."""
    panels = [("Start of the session", history[0]["before"], None, None)] + \
             [(step_title(h), h["after"], h["before"], h["step"]["id"]) for h in history]
    rows = int(np.ceil(len(panels) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(8.5 * cols, 4.8 * rows))
    for ax, (t, st, prev, new) in zip(axes.ravel(), panels):
        draw_tree(st, ax, t, prev, new)
    for ax in axes.ravel()[len(panels):]:
        ax.axis("off")
    if title:
        fig.suptitle(title, x=0.01, ha="left", fontsize=12, weight="bold")
    legend(fig, y=-0.01)
    plt.tight_layout()
    plt.show()


def show_step(history, k):
    """One step in detail: the tree before and after step k."""
    h = history[k - 1]
    fig, axes = plt.subplots(1, 2, figsize=(17, 5.2))
    draw_tree(h["before"], axes[0], f"Before step {k}")
    draw_tree(h["after"], axes[1], step_title(h, 60), h["before"], h["step"]["id"])
    legend(fig, y=-0.04)
    plt.tight_layout()
    plt.show()


def show_final_trees(histories, metrics=None, cols=2):
    """Final forests of several designs, `cols` per row. histories: {name: history}."""
    rows = int(np.ceil(len(histories) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(8.5 * cols, 5.2 * rows))
    for ax, (name, hist) in zip(np.atleast_1d(axes).ravel(), histories.items()):
        sub = f"\n{metrics(hist)}" if metrics else ""
        draw_tree(hist[-1]["after"], ax, f"{name}: final forest{sub}")
    for ax in np.atleast_1d(axes).ravel()[len(histories):]:
        ax.axis("off")
    plt.tight_layout()
    plt.show()


# ------------------------------------------------------------------ animation
def _ease(t):
    return t * t * (3 - 2 * t)                       # smooth start and stop


def _draw_frame(ax, h, t, limits):
    """Frame at time t in [0, 1] of the morph from h['before'] to h['after']."""
    ax.clear()
    before, after, n = h["before"], h["after"], h["step"]["id"]
    groups = after["groups"]
    nb, db = geometry(before)
    na, da = geometry(after)
    e = _ease(t)
    P = {c: (nb[c] * (1 - e) + na[c] * e if c in nb else na[c]) for c in na}   # node positions now
    A = {c: (1.0 if c in nb else e) for c in na}                                 # new nodes fade in
    topics = after["topics"]
    shown = before if e < 0.5 else after                                         # whose counts to show

    for c, tpc in topics.items():                    # wood
        p0, p1 = P[tpc["parent"]], P[c]
        load = len(_members(after, c))
        ax.plot([p0[0], p1[0]], [p0[1] + (0.0 if tpc["parent"] in groups else 0.5), p1[1] - 0.45],
                color=COL["wood"], lw=1.4 + 0.6 * np.sqrt(load), alpha=A[c], solid_capstyle="round", zorder=1)
    (x0, x1), _ = limits                             # the ground and the groups
    ax.plot([x0 + 0.7, x1 - 0.7], [-0.05] * 2, color=COL["wood"], lw=1, ls=(0, (1, 3)))
    for g, label in groups.items():
        ax.text(P[g][0], -0.32, label, ha="center", va="center", weight="bold", fontsize=10, alpha=A[g], **FONT)
    for c in topics:                                 # topics
        is_new = c not in before["topics"]
        box = dict(boxstyle="round,pad=0.3", fc="white", ec=COL["moved"] if is_new else "none",
                   ls="--" if is_new else "-", lw=1.2, alpha=A[c])
        text, lines = _label(topics[c]["label"])
        ax.text(*P[c], text, ha="center", va="center", fontsize=9, zorder=4, bbox=box, linespacing=1.0,
                alpha=A[c], **FONT)
        if c in shown["topics"]:
            note, color = _size_note(len(_members(shown, c)))
            ax.text(P[c][0], P[c][1] - 0.27 - 0.07 * (lines - 1), note, ha="center", va="center", fontsize=7.5, color=color,
                    alpha=A[c], **FONT)
    for p in after["assign"]:                        # prompts
        if p == n:                                   # the new prompt drops in from above
            xy, color, alpha = da[p] + np.array([0, 1.2 * (1 - e)]), COL["new"], min(1, 2 * e)
        else:
            moved = before["assign"][p] != after["assign"][p]
            xy, color, alpha = db[p] * (1 - e) + da[p] * e, COL["moved"] if moved else COL["old"], 1
        ax.scatter(*xy, s=70, color=color, alpha=alpha, edgecolors="white", linewidths=1.2, zorder=5)
    ax.set_xlim(*limits[0])
    ax.set_ylim(*limits[1])
    ax.axis("off")
    ax.set_title(step_title(h, 60), loc="left", fontsize=10.5)


def _limits(history):
    xs, ys = [], []
    for h in history:
        for st in (h["before"], h["after"]):
            node, _ = geometry(st)
            xs += [v[0] for v in node.values()]
            ys += [v[1] for v in node.values()]
    return (min(xs) - 1.4, max(xs) + 1.4), (-0.7, max(ys) + 1.6)


def _animate(steps, frames_hold=6, frames_move=18, interval=70, gif=None):
    limits = _limits(steps)
    schedule = []                                    # (step, t) for every frame
    for h in steps:
        schedule += [(h, 0.0)] * frames_hold
        schedule += [(h, i / (frames_move - 1)) for i in range(frames_move)]
        schedule += [(h, 1.0)] * (frames_hold + 4)
    fig, ax = plt.subplots(figsize=(9, 5), dpi=80)
    legend(fig, y=0.0, moves=False)
    anim = animation.FuncAnimation(fig, lambda i: _draw_frame(ax, *schedule[i], limits),
                                   frames=len(schedule), interval=interval)
    if gif:
        anim.save(gif, writer=animation.PillowWriter(fps=int(1000 / interval)))
        print("saved", gif)
    plt.close(fig)                                   # show only the player, not an extra static figure
    return HTML(anim.to_jshtml(default_mode="loop"))


def animate_step(history, k, gif=None):
    """Animate step k: the tree before morphs into the tree after."""
    return _animate([history[k - 1]], gif=gif)


def animate_session(history, gif=None):
    """Animate the whole session, step after step."""
    return _animate(history, frames_hold=3, frames_move=10, gif=gif)


# ------------------------------------------------------------------ tables
def _steps_index():
    return pd.Index([f'{k}: {st["id"]}' for k, st in enumerate(SESSION, start=1)], name="step")


def question_table():
    """The questions of the session, in the order they arrive."""
    return pd.DataFrame({"question": [st["text"] for st in SESSION]}, index=_steps_index())


def _born(c):
    """Step at which topic c was proposed (0: in the starting forest)."""
    return next((forest.STEP_K[q] for q, t in forest.PROPOSALS.items() if t["id"] == c), 0)


def proposal_tables(s):
    """The LLM's proposals, the fits s(p, c) when a question arrived, and the later ratings of earlier questions
    against new proposals (with the step at which they were asked)."""
    J, labels, props = forest.JUDGE, forest.ALL_LABELS, forest.PROPOSALS

    def where(t):
        if t["parent"] in forest.ALL_TOPICS:
            return f'branch of {labels[t["parent"]]}'
        new = " (new group)" if t["parent"] not in INITIAL_GROUPS and t["kind"] == "new_group" else ""
        return f'new tree in {forest.ALL_GROUPS[t["parent"]]}' + new

    def best_before(n, k):
        c = max([c for c in forest.ALL_TOPICS if _born(c) < k], key=lambda c: int(J[n].get(c, 1)))
        return f'{labels[c]} ({int(J[n].get(c, 1))})'

    display(pd.DataFrame({
        "question": [st["text"] for st in SESSION],
        "best topic before this step": [best_before(st["id"], k) for k, st in enumerate(SESSION, start=1)],
        "proposed topic": [props[st["id"]]["label"] if st["id"] in props else "-" for st in SESSION],
        "where": [where(props[st["id"]]) if st["id"] in props else "" for st in SESSION],
    }, index=_steps_index()))

    arrival = lambda p: forest.STEP_K.get(p, 0)
    ps, cols = list(all_prompts()), list(labels.values())
    now = pd.DataFrame([[f"{s(p, c):.2f}" if _born(c) <= arrival(p) and c in J[p] else "-" for c in labels]
                        for p in ps], index=ps, columns=cols)
    print("Fit s_pc when the question arrived ('-' = topic proposed later)")
    display(now)
    later = pd.DataFrame([[f"{s(p, c):.2f} (step {_born(c)})" if _born(c) > arrival(p) and c in J[p] else ""
                           for c in labels] for p in ps], index=ps, columns=cols)
    later = later.loc[(later != "").any(axis=1), (later != "").any(axis=0)]
    print("Ratings of earlier questions against later proposals (for moving them), with the step they were asked")
    display(later)


def step_table(history, s, lookup):
    """One row per step: where the new question went, what was created, moved or deleted, the outcome, and the
    mean lookup time lookup(state, params) of the forest after the step."""
    rows = []
    for h in history:
        n, before, after = h["step"]["id"], h["before"], h["after"]
        label = lambda state, c: state["topics"][c]["label"]
        c = after["assign"][n]
        moved, created, deleted, new_groups = forest.changes(before, after)
        rows.append({
            "new question": h["step"]["text"],
            "placed in": label(after, c),
            "fit (judge score)": f'{s(n, c):.2f} ({int(forest.JUDGE[n].get(c, 1))})',
            "created": ", ".join([label(after, t) for t in created]
                                 + [f'group {after["groups"][g]}' for g in new_groups]) or "-",
            "moved / deleted": ", ".join([f'{p} → {label(after, after["assign"][p])}' for p in moved]
                                         + [f'deleted {label(before, d)}' for d in deleted]) or "-",
            "outcome": h["action"],
            "lookup time (s)": lookup(after, h["params"]),
        })
    return pd.DataFrame(rows, index=pd.Index([h["k"] for h in history], name="step"))


def outcome_table(histories):
    """The outcome letter (a)-(e) of every step, one column per design. histories: {name: history}."""
    first = next(iter(histories.values()))
    index = pd.Index([f'{h["k"]}: {textwrap.shorten(h["step"]["text"], 45, placeholder="…")}' for h in first],
                     name="step")
    return pd.DataFrame({name: [forest.code_of(h["action"]) for h in hist] for name, hist in histories.items()},
                        index=index)
