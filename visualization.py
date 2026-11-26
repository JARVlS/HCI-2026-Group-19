"""Drawing helpers for ui_optimization.ipynb (HCI 2026, Group 19, Milestone 3).

The notebook represents a knowledge tree as a *state*:
    state = {"topics": {topic_id: {"label": str, "parent": subject or topic_id}},
             "assign": {prompt_id: topic_id},
             "w":      {prompt_id: float}}
and a session as a *history*: one dict per step with the keys
    k, step, before, after, action, parts, params
(produced by run_session in the notebook).

Public functions
    draw_tree(state, ax, ...)          one tree on a matplotlib axis
    show_session(history)              one tree per step (grid)
    show_step(history, k)              one step, before and after
    animate_step(history, k)           one step as an animation
    animate_session(history)           the whole session as an animation
"""
import textwrap

import numpy as np
import matplotlib.pyplot as plt
from matplotlib import animation
from matplotlib.lines import Line2D
from matplotlib.patches import FancyArrowPatch
from IPython.display import HTML

COL = {"new": "#2a78d6", "moved": "#eb6834", "old": "#b8b7b2", "ink": "#0b0b0b",
       "muted": "#52514e", "wood": "#8c8579", "warn": "#e34948"}
FONT = dict(family="monospace")
X, V, DOT = 2.0, 1.7, 0.17          # horizontal / vertical spacing of the tree, spacing of prompt dots

plt.rcParams["animation.embed_limit"] = 60   # MB, allows embedding the session animation


# ------------------------------------------------------------------ layout
def subject_of(state):
    """The root of the tree: the one parent that is not itself a topic."""
    roots = {t["parent"] for t in state["topics"].values()} - set(state["topics"])
    return roots.pop()


def _children(state, node):
    return [c for c, t in state["topics"].items() if t["parent"] == node]


def _members(state, c):
    return [p for p, t in state["assign"].items() if t == c]


def geometry(state):
    """Positions of every node (subject and topics) and of every prompt dot.

    Tidy layout: leaves get consecutive x positions, a parent sits above the middle of its children,
    depth grows upwards.
    """
    subject = subject_of(state)
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

    place(subject, 0)
    node = {c: np.array([x * X, d * V]) for c, (x, d) in pos.items()}
    dots = {}
    for c in state["topics"]:
        ms = _members(state, c)
        for i, p in enumerate(ms):
            dots[p] = node[c] + np.array([(i - (len(ms) - 1) / 2) * DOT, 0.3])
    return node, dots


def _size_note(k, U=None, L=None, is_new=False):
    note, color = f"{k} prompt{'s' if k != 1 else ''}", COL["muted"]
    if U is not None and k > U:
        note, color = note + f" · over U={U}", COL["warn"]
    elif L is not None and is_new and k < L:
        note, color = note + f" · under L={L}", COL["warn"]
    return note, color


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
def draw_tree(state, ax, title="", prev=None, new_prompt=None, U=None, L=None):
    """Draw one tree like the prototype's tree view.

    prev:       state before the step; marks moved prompts and new topics
    new_prompt: id of the prompt asked in this step (blue)
    U, L:       if given, topic sizes over U (or new topics under L) are flagged in red
    """
    subject = subject_of(state)
    topics = state["topics"]
    node, dots = geometry(state)

    def load(c):  # prompts in the subtree of c: the wood gets thicker towards the root
        return len(_members(state, c)) + sum(load(k) for k in _children(state, c))

    for c in node:                                   # wood
        for k in _children(state, c):
            (x0, y0), (x1, y1) = node[c], node[k]
            ax.plot([x0, x1], [y0 + (0.0 if c == subject else 0.5), y1 - 0.45], color=COL["wood"],
                    lw=1.0 + 0.9 * np.sqrt(load(k)), solid_capstyle="round", zorder=1)

    xs = [v[0] for v in node.values()]
    sx, sy = node[subject]                           # the subject below the ground line
    ax.plot([min(xs) - 0.6, max(xs) + 0.6], [sy - 0.05] * 2, color=COL["wood"], lw=1, ls=(0, (1, 3)))
    ax.text(sx, sy - 0.32, subject, ha="center", va="center", weight="bold", fontsize=9.5, **FONT)

    for c, (x, y) in node.items():                   # topics and their prompts
        if c == subject:
            continue
        is_new = prev is not None and c not in prev["topics"]
        box = dict(boxstyle="round,pad=0.3", fc="white", ec=COL["moved"] if is_new else "none",
                   ls="--" if is_new else "-", lw=1.2)
        ax.text(x, y, topics[c]["label"], ha="center", va="center", fontsize=8.5, zorder=4, bbox=box, **FONT)
        for p in _members(state, c):
            moved = prev is not None and p in prev["assign"] and prev["assign"][p] != c
            kind = "new" if p == new_prompt else ("moved" if moved else "old")
            ax.scatter(*dots[p], s=55, color=COL[kind], edgecolors="white", linewidths=1.2, zorder=5)
        note, color = _size_note(len(_members(state, c)), U, L, is_new)
        ax.text(x, y - 0.27, note, ha="center", va="center", fontsize=7, color=color, zorder=4, **FONT)

    if prev is not None:                             # moves: dashed arrow from the old topic
        for p, c1 in state["assign"].items():
            c0 = prev["assign"].get(p)
            if c0 and c0 != c1:
                w0 = len(_members(state, c0)) * DOT / 2 + 0.15
                w1 = len(_members(state, c1)) * DOT / 2 + 0.15
                (x0, y0), (x1, y1) = node[c0], node[c1]
                ax.add_patch(FancyArrowPatch((x0 + w0, y0 + 0.3), (x1 + w1, y1 + 0.3),
                                             connectionstyle="arc3,rad=0.45", arrowstyle="-|>", mutation_scale=10,
                                             color=COL["moved"], lw=1, ls="--", zorder=3))
    ax.set_xlim(min(xs) - 1.3, max(xs) + 1.3)
    ax.set_ylim(-0.6, max(v[1] for v in node.values()) + 0.6)
    ax.axis("off")
    ax.set_title(title, loc="left", fontsize=9.5)


def _UL(h):
    params = h.get("params", {})
    return params.get("U"), params.get("L")


def show_session(history, title=None, cols=3):
    """One tree per step, starting with the tree before the session."""
    U, L = _UL(history[0])
    panels = [("Start of the session", history[0]["before"], None, None)] + \
             [(step_title(h), h["after"], h["before"], h["step"]["id"]) for h in history]
    rows = int(np.ceil(len(panels) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(6.2 * cols, 4.6 * rows))
    for ax, (t, st, prev, new) in zip(axes.ravel(), panels):
        draw_tree(st, ax, t, prev, new, U, L)
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
    U, L = _UL(h)
    fig, axes = plt.subplots(1, 2, figsize=(13, 5))
    draw_tree(h["before"], axes[0], f"Before step {k}", U=U, L=L)
    draw_tree(h["after"], axes[1], step_title(h, 60), h["before"], h["step"]["id"], U, L)
    legend(fig, y=-0.04)
    plt.tight_layout()
    plt.show()


def show_final_trees(histories, metrics=None):
    """Final tree of several designs side by side. histories: {name: history}."""
    fig, axes = plt.subplots(1, len(histories), figsize=(6.3 * len(histories), 5.2))
    for ax, (name, hist) in zip(np.atleast_1d(axes), histories.items()):
        U, L = _UL(hist[0])
        sub = f"\n{metrics(hist)}" if metrics else ""
        draw_tree(hist[-1]["after"], ax, f"{name}: final tree{sub}", U=U, L=L)
    plt.tight_layout()
    plt.show()


# ------------------------------------------------------------------ animation
def _ease(t):
    return t * t * (3 - 2 * t)                       # smooth start and stop


def _draw_frame(ax, h, t, limits):
    """Frame at time t in [0, 1] of the morph from h['before'] to h['after']."""
    ax.clear()
    U, _ = _UL(h)
    before, after, n = h["before"], h["after"], h["step"]["id"]
    subject = subject_of(after)
    nb, db = geometry(before)
    na, da = geometry(after)
    e = _ease(t)
    P = {c: (nb[c] * (1 - e) + na[c] * e if c in nb else na[c]) for c in na}   # node positions now
    A = {c: (1.0 if c in nb else e) for c in na}                                 # new topics fade in
    topics = after["topics"]
    shown = before if e < 0.5 else after                                         # whose counts to show

    for c, tpc in topics.items():                    # wood
        p0, p1 = P[tpc["parent"]], P[c]
        load = len(_members(after, c))
        ax.plot([p0[0], p1[0]], [p0[1] + (0.0 if tpc["parent"] == subject else 0.5), p1[1] - 0.45],
                color=COL["wood"], lw=1.4 + 0.6 * np.sqrt(load), alpha=A[c], solid_capstyle="round", zorder=1)
    (x0, x1), _ = limits                             # subject
    ax.plot([x0 + 0.7, x1 - 0.7], [P[subject][1] - 0.05] * 2, color=COL["wood"], lw=1, ls=(0, (1, 3)))
    ax.text(P[subject][0], P[subject][1] - 0.32, subject, ha="center", va="center", weight="bold",
            fontsize=10, **FONT)
    for c in topics:                                 # topics
        is_new = c not in before["topics"]
        box = dict(boxstyle="round,pad=0.3", fc="white", ec=COL["moved"] if is_new else "none",
                   ls="--" if is_new else "-", lw=1.2, alpha=A[c])
        ax.text(*P[c], topics[c]["label"], ha="center", va="center", fontsize=9, zorder=4, bbox=box,
                alpha=A[c], **FONT)
        if c in shown["topics"]:
            note, color = _size_note(len(_members(shown, c)), U)
            ax.text(P[c][0], P[c][1] - 0.27, note, ha="center", va="center", fontsize=7.5, color=color,
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
    return (min(xs) - 1.4, max(xs) + 1.4), (-0.6, max(ys) + 1.6)


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
    return _animate(history, frames_hold=4, frames_move=14, gif=gif)
