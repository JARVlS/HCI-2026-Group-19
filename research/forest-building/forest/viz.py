"""Figures: forest drawings, method comparisons, what-if heatmaps.

Colours follow the reference data-viz palette (categorical slots in fixed order; one-hue blue ramp
for magnitude). A method keeps its colour in every figure.
"""
from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap, ListedColormap

from .model import Forest

SURFACE = "#fcfcfb"
TEXT = "#0b0b0b"
TEXT_2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
METHOD_ORDER = ["ip", "ip_full_recluster", "judge_argmax", "judge_restructure", "greedy", "chronological"]
METHOD_COLOR = dict(zip(METHOD_ORDER, SLOTS))
BLUES = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6",
         "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"]
SEQ = LinearSegmentedColormap.from_list("arbor_blue", BLUES)
ACTION_COLOR = {"a": "#cde2fb", "b": "#86b6ef", "c": "#1baf7a", "d": "#eda100", "e": "#e87ba4"}
ACTION_LABEL = {"a": "add", "b": "new branch", "c": "new tree", "d": "new group", "e": "rebalance"}


def style() -> None:
    plt.rcParams.update({
        "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
        "axes.edgecolor": AXIS, "axes.labelcolor": TEXT_2, "axes.titlecolor": TEXT, "axes.titlesize": 11,
        "axes.titleweight": "semibold", "axes.titlelocation": "left", "axes.labelsize": 9,
        "xtick.color": MUTED, "ytick.color": MUTED, "xtick.labelsize": 8, "ytick.labelsize": 8,
        "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
        "axes.spines.top": False, "axes.spines.right": False, "legend.frameon": False, "legend.fontsize": 8,
        "font.size": 9, "lines.linewidth": 2, "figure.dpi": 110, "savefig.dpi": 200, "savefig.bbox": "tight",
    })


def save(fig, path: Path | str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path)


# --- forest drawing --------------------------------------------------------------------------------

def plot_forest(f: Forest, ax=None, title: str = "", new: set[str] = frozenset(), moved: set[str] = frozenset(),
                renamed: set[str] = frozenset(), wrap: int = 18):
    """Groups on top, topics below by depth, '(n)' = prompts attached. New topics aqua, moved or
    renamed ones orange (also marked in the label, so colour is not the only cue)."""
    ax = ax or plt.gca()
    ax.set_axis_off()
    ax.set_title(title)
    if not f.groups:
        ax.text(0.5, 0.5, "(empty forest)", ha="center", color=MUTED, transform=ax.transAxes)
        return ax
    pos: dict[str, tuple[float, float]] = {}
    x = 0.0

    def place(c: str) -> float:
        nonlocal x
        kids = sorted(f.children(c), key=lambda k: f.topics[k].label)
        if not kids:
            pos[c] = (x, -(f.depth(c) + 1))
            x += 1
        else:
            xs = [place(k) for k in kids]
            pos[c] = (float(np.mean(xs)), -(f.depth(c) + 1))
        return pos[c][0]

    for g in f.groups:
        start = x
        xs = [place(r) for r in sorted(f.roots(g), key=lambda r: f.topics[r].label)]
        pos[g] = (float(np.mean(xs)) if xs else start, 0.0)
        x += 0.6
    for c, t in f.topics.items():
        px, py = pos[t.parent_id]
        cx, cy = pos[c]
        ax.plot([px, cx], [py - 0.12, cy + 0.12], color=AXIS, lw=1, zorder=1)

    def wrapped(s: str) -> str:
        words, lines, cur = s.split(), [], ""
        for w in words:
            if len(cur) + len(w) + 1 > wrap and cur:
                lines.append(cur)
                cur = w
            else:
                cur = f"{cur} {w}".strip()
        lines.append(cur)
        return "\n".join(lines)

    for g, grp in f.groups.items():
        gx, gy = pos[g]
        ax.text(gx, gy, wrapped(grp.label), ha="center", va="center", fontsize=8, fontweight="semibold", color=SURFACE,
                bbox=dict(boxstyle="round,pad=0.35", fc=TEXT_2, ec="none"), zorder=3)
    for c, t in f.topics.items():
        cx, cy = pos[c]
        mark = " *" if c in new else (" ~" if c in moved or c in renamed else "")
        fc = SLOTS[2] if c in new else (SLOTS[1] if c in moved or c in renamed else "#f0efec")
        tc = SURFACE if c in new or c in moved or c in renamed else TEXT
        ax.text(cx, cy, f"{wrapped(t.label)}{mark}\n({len(f.prompts_in(c))})", ha="center", va="center", fontsize=7,
                color=tc, bbox=dict(boxstyle="round,pad=0.3", fc=fc, ec="none"), zorder=3)
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    ax.set_xlim(min(xs) - 0.8, max(xs) + 0.8)
    ax.set_ylim(min(ys) - 0.7, 0.6)
    return ax


def forest_change_sets(prev: Forest, cur: Forest) -> dict[str, set[str]]:
    return {"new": {c for c in cur.topics if c not in prev.topics},
            "moved": {c for c in cur.topics if c in prev.topics and
                      (cur.topics[c].parent_id, cur.topics[c].parent_kind) != prev.parent_of(c)},
            "renamed": {c for c in cur.topics if c in prev.topics and cur.topics[c].label != prev.topics[c].label}}


# --- method comparison -----------------------------------------------------------------------------

def line_by_method(steps, metric: str, ax=None, title: str = "", ylabel: str = "", cumulative: bool = False):
    ax = ax or plt.gca()
    for m in [m for m in METHOD_ORDER if m in set(steps["method"])]:
        d = steps[steps["method"] == m].sort_values("step")
        y = d[metric].cumsum() if cumulative else d[metric]
        ax.plot(d["step"], y, color=METHOD_COLOR[m], lw=2.4 if m == "ip" else 1.6, label=m, zorder=3 if m == "ip" else 2)
    ax.set_title(title)
    ax.set_xlabel("step (prompt number)")
    ax.set_ylabel(ylabel)
    ax.legend(loc="upper left", ncol=2)
    return ax


def fit_vs_disruption(summary, ax=None, title: str = "Final fit vs total disruption",
                      x: str = "disruption_w", y: str = "final_fit"):
    """One point per method, each labelled by name (colour is not the only cue)."""
    ax = ax or plt.gca()
    for _, r in summary.iterrows():
        m = r["method"]
        ax.scatter(r[x], r[y], s=70, color=METHOD_COLOR.get(m, MUTED), edgecolor=SURFACE, linewidth=2, zorder=3)
        ax.annotate(m, (r[x], r[y]), xytext=(6, 4), textcoords="offset points", fontsize=8, color=TEXT_2)
    ax.set_xlabel("total weighted disruption (sum of w for moved prompts + v for moved or removed categories)")
    ax.set_ylabel("final prompt fit (sum over prompts)")
    ax.set_title(title)
    return ax


# --- what-if ---------------------------------------------------------------------------------------

def heatmap(table, ax=None, title: str = "", fmt: str = "{:.1f}", xlabel: str = "", ylabel: str = "", cbar_label: str = ""):
    """Magnitude grid (pandas pivot table): one-hue ramp, value printed in each cell."""
    ax = ax or plt.gca()
    vals = table.values.astype(float)
    im = ax.imshow(vals, cmap=SEQ, aspect="auto", origin="lower")
    ax.set_xticks(range(table.shape[1]), [f"{c:g}" if isinstance(c, (int, float)) else str(c) for c in table.columns])
    ax.set_yticks(range(table.shape[0]), [f"{r:g}" if isinstance(r, (int, float)) else str(r) for r in table.index])
    ax.grid(False)
    lo, hi = np.nanmin(vals), np.nanmax(vals)
    for i in range(vals.shape[0]):
        for j in range(vals.shape[1]):
            v = vals[i, j]
            dark = hi > lo and (v - lo) / (hi - lo) > 0.55
            ax.text(j, i, fmt.format(v), ha="center", va="center", fontsize=7, color=SURFACE if dark else TEXT)
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    cb = plt.colorbar(im, ax=ax, fraction=0.046, pad=0.02)
    cb.set_label(cbar_label, color=TEXT_2, fontsize=8)
    cb.outline.set_visible(False)
    return ax


def action_heatmap(table, ax=None, title: str = "", xlabel: str = "", ylabel: str = ""):
    """Categorical grid of actions (a..e); each cell also carries its letter."""
    ax = ax or plt.gca()
    letters = list(ACTION_COLOR)
    codes = np.vectorize(lambda a: letters.index(a))(table.values)
    ax.imshow(codes, cmap=ListedColormap(list(ACTION_COLOR.values())), vmin=-0.5, vmax=len(letters) - 0.5,
              aspect="auto", origin="lower")
    for i in range(codes.shape[0]):
        for j in range(codes.shape[1]):
            a = table.values[i, j]
            ax.text(j, i, a, ha="center", va="center", fontsize=8, color=TEXT)
    ax.set_xticks(range(table.shape[1]), [f"{c:g}" for c in table.columns])
    ax.set_yticks(range(table.shape[0]), [f"{r:g}" for r in table.index])
    ax.grid(False)
    present = sorted(set(table.values.ravel()))
    handles = [plt.Rectangle((0, 0), 1, 1, color=ACTION_COLOR[a]) for a in present]
    ax.legend(handles, [f"{a}: {ACTION_LABEL[a]}" for a in present], loc="upper left", bbox_to_anchor=(1.01, 1))
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    return ax


def pareto(points: list[tuple[float, float]]) -> list[int]:
    """Indices of points not dominated (lower disruption x, higher fit y)."""
    keep = []
    for i, (x, y) in enumerate(points):
        if not any((x2 <= x and y2 >= y) and (x2 < x or y2 > y) for x2, y2 in points):
            keep.append(i)
    return sorted(keep, key=lambda i: points[i][0])
