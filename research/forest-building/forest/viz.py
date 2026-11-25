"""Forest drawings with judge and IP overlays, matplotlib only (plan Section 7).

draw_forest   one forest, top-down: groups on top, topics as boxes, depth downwards
Overlay       marks on a drawing: judge fits, proposals, moves, what the IP adopted or rejected
step_view     before | judge | IP result for one simulation step
compare_view  several forests side by side, prompts outside their ideal topic in red
step_browser  ipywidgets slider over the steps of a run
save_storyboard  one step_view PNG per step
"""
from __future__ import annotations

import math
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Patch

from . import ROOT
from .ip import ACTIONS, Decision, Params
from .judge import NEW_GROUP, JudgeOutput
from .model import Forest

FIGURES = ROOT / "outputs" / "figures"
INK, INK2, MUTED = "#0b0b0b", "#52514e", "#898781"
GROUP_FC, TOPIC_FC, EDGE = "#52514e", "#f0efec", "#c3c2b7"
ORANGE, GREEN, GREY, RED = "#eb6834", "#008300", "#a9a8a3", "#d03b3b"
FIT_FC = {1: "#f0efec", 2: "#cde2fb", 3: "#9ec5f4", 4: "#5598e7", 5: "#256abf"}   # light = 1, dark = 5
BOX_W, LINE_H = 0.9, 0.15


@dataclass
class Overlay:
    new_prompt: str | None = None
    fits: dict[str, int] = field(default_factory=dict)      # topic id -> judge fit of the new prompt
    proposals: list[dict] = field(default_factory=list)     # name, fit, parents [(ref, fit)], status, id
    new_groups: list[dict] = field(default_factory=list)    # ref (NEW_GROUP:x), label, status, id
    moves: list[dict] = field(default_factory=list)         # kind, id, to, fit, status, src (topic id)
    moved: set[str] = field(default_factory=set)            # topic or prompt ids moved this step
    deleted: list[tuple[str, str]] = field(default_factory=list)  # (id, label) removed this step
    misplaced: set[str] = field(default_factory=set)        # prompt ids drawn red


# --- layout --------------------------------------------------------------------------------------

def _content(f: Forest, t: str, show: str) -> list[str]:
    ps = f.prompts_in(t)
    if show == "count":
        return [f"{len(ps)} prompt{'s' * (len(ps) != 1)}"] if ps else []
    if show == "text":
        return [f.prompts[p].text[:30] for p in ps]
    return ps


def _box_h(f: Forest, t: str, show: str) -> float:
    label = len(textwrap.wrap(f.topics[t].label, 16)) or 1
    c = _content(f, t, show)
    rows = math.ceil(len(c) / 3) if show == "ids" else len(c)
    return LINE_H * (label + rows) + 0.12


def _layout(f: Forest, show: str) -> tuple[dict[str, tuple[float, float]], float]:
    level = max([_box_h(f, t, show) for t in f.topics] + [0.6]) + 0.35
    pos: dict[str, tuple[float, float]] = {}
    x = 0.0

    def place(t: str) -> float:
        nonlocal x
        kids = f.children(t)
        if not kids:
            pos[t] = (x, -(f.depth(t) + 1) * level)
            x += 1.0
        else:
            xs = [place(k) for k in kids]
            pos[t] = ((xs[0] + xs[-1]) / 2, -(f.depth(t) + 1) * level)
        return pos[t][0]

    for g in f.groups:
        xs = [place(r) for r in f.roots(g)]
        pos[g] = ((xs[0] + xs[-1]) / 2 if xs else x, 0.0)
        x += 0.4
    return pos, level


# --- drawing -------------------------------------------------------------------------------------

def _box(ax, cx, cy, w, h, fc, ec, lw=1.0, ls="-", z=3):
    ax.add_patch(FancyBboxPatch((cx - w / 2, cy - h / 2), w, h, boxstyle="round,pad=0.02,rounding_size=0.05",
                                fc=fc, ec=ec, lw=lw, ls=ls, zorder=z))


def _arrow(ax, a, b, color, ls, label=None, cross=False, rad=0.25):
    ax.add_patch(FancyArrowPatch(a, b, connectionstyle=f"arc3,rad={rad}", arrowstyle="-|>", mutation_scale=9,
                                 color=color, lw=1.3, ls=ls, zorder=5, shrinkA=6, shrinkB=6))
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    if cross:
        ax.text(mx, my, "×", color=color, fontsize=12, ha="center", va="center", zorder=6, fontweight="bold")
    if label:
        ax.text(mx, my + 0.08, label, color=color, fontsize=6.5, ha="center", va="bottom", zorder=6,
                bbox=dict(boxstyle="round,pad=0.1", fc="white", ec="none", alpha=0.85))


def draw_forest(forest: Forest, ax=None, overlay: Overlay | None = None, show_prompts: str = "ids",
                P: Params | None = None, title: str = ""):
    """Draw one forest. Topics above U get a red border, topics below L a dashed one."""
    ax = ax or plt.gca()
    P, ov = P or Params(), overlay or Overlay()
    pos, level = _layout(forest, show_prompts)
    ax.set_axis_off()
    ax.set_title(title, fontsize=9, loc="left", color=INK)
    used: set[str] = set()

    # ghost slots: proposals that are not (or no longer) in this forest, new groups, deleted topics
    ghost_y = -(max([forest.depth(t) for t in forest.topics] + [0]) + 2) * level
    xmax = max([p[0] for p in pos.values()] + [0])
    gx = 0.0
    ghost: dict[str, tuple[float, float]] = {}
    for p in ov.proposals:
        if not (p.get("id") in forest.topics and p["status"] == "adopted"):
            ghost[p["name"].lower()] = (gx, ghost_y)
            gx += 1.1
    for tid, _ in ov.deleted:
        ghost[tid] = (gx, ghost_y)
        gx += 1.1
    nx = xmax + 1.2
    for g in ov.new_groups:
        if not (g.get("id") in forest.groups and g["status"] == "adopted"):
            ghost[g["ref"].lower()] = (nx, 0.0)
            nx += 1.2

    def where(ref: str | None):
        if ref is None:
            return None
        if ref in pos:
            return pos[ref]
        return ghost.get(ref.lower())

    # tree edges
    for t in forest.topics.values():
        (px, py), (cx, cy) = pos[t.parent], pos[t.id]
        ax.plot([px, cx], [py - 0.18, cy + _box_h(forest, t.id, show_prompts) / 2], color=EDGE, lw=1, zorder=1)

    # groups
    for g in forest.groups.values():
        cx, cy = pos[g.id]
        adopted = any(ng.get("id") == g.id and ng["status"] == "adopted" for ng in ov.new_groups)
        _box(ax, cx, cy, BOX_W * 1.35, 0.36, GROUP_FC, GREEN if adopted else GROUP_FC, lw=2.2 if adopted else 1)
        ax.text(cx, cy, textwrap.fill(g.label, 18), ha="center", va="center", fontsize=7.2, color="white",
                fontweight="bold", zorder=4)
        used |= {"adopted"} if adopted else set()

    # topics
    for t in forest.topics.values():
        cx, cy = pos[t.id]
        h = _box_h(forest, t.id, show_prompts)
        n_prompts = len(forest.prompts_in(t.id))
        fc = FIT_FC[ov.fits[t.id]] if t.id in ov.fits else TOPIC_FC
        adopted = any(p.get("id") == t.id and p["status"] == "adopted" for p in ov.proposals)
        ec, lw, ls = EDGE, 1.0, "-"
        if n_prompts > P.U:
            ec, lw = RED, 2.0
            used.add("over_U")
        if n_prompts + len(forest.children(t.id)) < P.L:
            ls = (0, (3, 2))
            used.add("under_L")
        if t.id in ov.moved or adopted:
            ec, lw = GREEN, 2.4
            used.add("moved" if t.id in ov.moved else "adopted")
        _box(ax, cx, cy, BOX_W, h, fc, ec, lw, ls)
        dark = t.id in ov.fits and ov.fits[t.id] >= 4
        label = textwrap.wrap(t.label, 16) or [""]
        top = cy + h / 2 - 0.06
        for i, line in enumerate(label):
            ax.text(cx, top - i * LINE_H, line, ha="center", va="top", fontsize=7 if len(line) <= 13 else 6.2,
                    fontweight="bold", color="white" if dark else INK, zorder=4)
        if t.id in ov.fits:
            ax.text(cx + BOX_W / 2 - 0.04, cy + h / 2 - 0.03, str(ov.fits[t.id]), ha="right", va="top", fontsize=6,
                    color="white" if dark else INK2, zorder=4)
            used.add("fits")
        y0 = top - len(label) * LINE_H
        items = _content(forest, t.id, show_prompts)
        for i, item in enumerate(items):
            if show_prompts == "ids":
                r, c = divmod(i, 3)
                ix, iy = cx - 0.28 + c * 0.28, y0 - r * LINE_H
            else:
                ix, iy = cx, y0 - i * LINE_H
            color, weight = ("white" if dark else INK2), "normal"
            if item == ov.new_prompt:
                color, weight = ORANGE, "bold"
                used.add("new")
            elif item in ov.moved:
                color, weight = GREEN, "bold"
                used.add("moved")
            elif item in ov.misplaced:
                color, weight = RED, "bold"
                used.add("misplaced")
            ax.text(ix, iy, item, ha="center", va="top", fontsize=6.3, color=color, fontweight=weight, zorder=4)

    # ghosts: proposed / rejected topics, new groups, deleted topics
    for p in ov.proposals:
        key = p["name"].lower()
        if key not in ghost:
            continue
        cx, cy = ghost[key]
        color = ORANGE if p["status"] == "proposed" else GREY
        _box(ax, cx, cy, BOX_W, 0.42, "white", color, 1.4, (0, (4, 2)))
        ax.text(cx, cy, textwrap.fill(f"{p['name']} ({p['fit']})", 16), ha="center", va="center", fontsize=6.8,
                color=color, fontweight="bold", zorder=4)
        used.add("proposed" if p["status"] == "proposed" else "rejected")
        for ref, fit in p["parents"]:
            target = where(ref)
            if target:
                ax.plot([cx, target[0]], [cy + 0.21, target[1] - 0.2], color=color, lw=1, ls=(0, (4, 2)), zorder=2)
                ax.text((cx + target[0]) / 2, (cy + target[1]) / 2, str(fit), color=color, fontsize=6.5, zorder=6,
                        bbox=dict(boxstyle="round,pad=0.1", fc="white", ec="none"))
    for g in ov.new_groups:
        key = g["ref"].lower()
        if key in ghost:
            cx, cy = ghost[key]
            color = ORANGE if g["status"] == "proposed" else GREY
            _box(ax, cx, cy, BOX_W, 0.36, "white", color, 1.4, (0, (4, 2)))
            ax.text(cx, cy, textwrap.fill(g["label"], 16), ha="center", va="center", fontsize=7, color=color,
                    fontweight="bold", zorder=4)
    for tid, label in ov.deleted:
        cx, cy = ghost[tid]
        _box(ax, cx, cy, BOX_W, 0.42, "#e6e5e0", GREY, 1.2)
        ax.text(cx, cy, textwrap.fill(label, 16), ha="center", va="center", fontsize=6.8, color=MUTED, zorder=4)
        ax.plot([cx - BOX_W / 2, cx + BOX_W / 2], [cy, cy], color=MUTED, lw=1.2, zorder=5)
        used.add("deleted")

    # moves
    for m in ov.moves:
        src = where(m["src"])
        dst = where(m["to"])
        if src is None or dst is None or m["status"] == "unusable":
            continue
        color, ls = {"proposed": (ORANGE, (0, (4, 2))), "adopted": (GREEN, "-"), "rejected": (GREY, (0, (4, 2)))}[m["status"]]
        label = f"{m['id']} ({m['fit']})" if m["kind"] == "prompt" else f"({m['fit']})"
        _arrow(ax, src, dst, color, ls, label=label, cross=m["status"] == "rejected")
        used.add({"proposed": "move", "adopted": "adopted", "rejected": "rejected"}[m["status"]])

    xs = [p[0] for p in list(pos.values()) + list(ghost.values())] or [0]
    ys = [p[1] for p in list(pos.values()) + list(ghost.values())] or [0]
    ax.set_xlim(min(xs) - 0.7, max(xs) + 0.7)
    ax.set_ylim(min(ys) - level * 0.7, 0.45)
    return used


LEGEND = {
    "new": Line2D([], [], color=ORANGE, marker="s", ls="", label="new prompt"),
    "fits": Patch(fc=FIT_FC[4], ec=EDGE, label="judge fit of the new prompt (light 1 - dark 5)"),
    "proposed": Patch(fc="white", ec=ORANGE, ls="--", label="proposed topic or group (fit)"),
    "move": Line2D([], [], color=ORANGE, ls="--", label="proposed move (fit)"),
    "adopted": Line2D([], [], color=GREEN, lw=2, label="adopted by the IP"),
    "rejected": Line2D([], [], color=GREY, ls="--", marker="x", label="rejected by the IP"),
    "moved": Patch(fc="white", ec=GREEN, lw=2, label="moved in this step"),
    "deleted": Patch(fc="#e6e5e0", ec=GREY, label="deleted in this step"),
    "over_U": Patch(fc="white", ec=RED, lw=2, label="more than U prompts"),
    "under_L": Patch(fc="white", ec=EDGE, ls="--", label="less than L content"),
    "misplaced": Line2D([], [], color=RED, marker="s", ls="", label="not in its ideal topic"),
}


def legend(fig, used: set[str]) -> None:
    handles = [LEGEND[k] for k in LEGEND if k in used]
    if handles:
        fig.legend(handles=handles, loc="lower center", ncol=min(6, len(handles)), fontsize=7.5, frameon=False,
                   bbox_to_anchor=(0.5, -0.02))


# --- composite views -----------------------------------------------------------------------------

def _judge_overlay(before: Forest, out: JudgeOutput, new_prompt: str) -> Overlay:
    ov = Overlay(new_prompt=new_prompt, fits={e.topic_id: e.fit for e in out.existing if e.topic_id in before.topics})
    refs = [pa.parent for p in out.proposed for pa in p.parents] + [m.to for m in out.restructure]
    for ref in dict.fromkeys(r for r in refs if r.startswith(NEW_GROUP)):
        ov.new_groups.append({"ref": ref, "label": ref[len(NEW_GROUP):], "status": "proposed"})
    for p in out.proposed:
        ov.proposals.append({"name": p.name, "fit": p.fit, "parents": [(pa.parent, pa.fit) for pa in p.parents],
                             "status": "proposed"})
    for m in out.restructure:
        src = (m.id if m.kind == "topic" else before.placement[m.id].topic) if (m.id in before.topics or m.id in before.placement) else None
        ov.moves.append({"kind": m.kind, "id": m.id, "to": m.to, "fit": m.fit, "status": "proposed", "src": src})
    return ov


def _result_overlay(before: Forest, out: JudgeOutput | None, dec: Decision, after: Forest, new_prompt: str) -> Overlay:
    ov = Overlay(new_prompt=new_prompt, moved=set(dec.diff.get("moved_prompts", [])) | set(dec.diff.get("moved_topics", [])),
                 deleted=[(t, before.topics[t].label) for t in dec.diff.get("deleted_topics", [])])
    if out is None:
        return ov
    for p in out.proposed:
        pid = dec.new_ids.get(p.name)
        status = "adopted" if p.name in dec.adopted else "rejected"
        ov.proposals.append({"name": p.name, "fit": p.fit, "parents": [(pa.parent, pa.fit) for pa in p.parents],
                             "status": status, "id": pid})
    for ref, gid in dec.new_ids.items():
        if ref.startswith(NEW_GROUP):
            ov.new_groups.append({"ref": ref, "label": ref[len(NEW_GROUP):], "id": gid,
                                  "status": "adopted" if gid in after.groups else "rejected"})
    for m, ok in dec.moves:
        status = "unusable" if ok is None else ("adopted" if ok else "rejected")
        nid = dec.new_ids.get(m.to)
        to = nid if nid and (nid in after.topics or nid in after.groups) else m.to
        if ok and m.kind == "topic":
            src = m.id
        else:
            src = (m.id if m.kind == "topic" else before.placement[m.id].topic) if (m.id in before.topics or m.id in before.placement) else None
            src = src if src in after.topics else None
        ov.moves.append({"kind": m.kind, "id": m.id, "to": to, "fit": m.fit, "status": status, "src": src})
    return ov


def action_summary(dec: Decision) -> str:
    d = dec.diff
    parts = []
    for key, word in (("moved_prompts", "prompt"), ("moved_topics", "topic")):
        if d.get(key):
            parts.append(f"{len(d[key])} {word}{'s' * (len(d[key]) != 1)} moved")
    deleted = len(d.get("deleted_topics", [])) + len(d.get("deleted_groups", []))
    if deleted:
        parts.append(f"{deleted} deleted")
    rejected = sum(ok is False for _, ok in dec.moves)
    if rejected:
        parts.append(f"{rejected} move{'s' * (rejected != 1)} rejected")
    if dec.rejected:
        parts.append(f"{len(dec.rejected)} proposal{'s' * (len(dec.rejected) != 1)} rejected")
    return f"({dec.action}) {ACTIONS[dec.action]}" + (": " + ", ".join(parts) if parts else "")


def step_view(before: Forest, judge_output: JudgeOutput | None, decision: Decision, after: Forest,
              P: Params | None = None, show_prompts: str = "ids", title: str = ""):
    """Before | judge | IP result for one step, with the objective terms underneath."""
    new = next(iter(set(after.placement) - set(before.placement)))
    text = after.prompts[new].text
    fig, axes = plt.subplots(1, 3, figsize=(21, 7))
    used = draw_forest(before, axes[0], None, show_prompts, P, title=textwrap.fill(f"Before step {after.step}. New prompt {new}: {text}", 70))
    if judge_output is not None:
        used |= draw_forest(before, axes[1], _judge_overlay(before, judge_output, new), show_prompts, P, title="Judge: fits and proposals")
    else:
        axes[1].set_axis_off()
        axes[1].set_title("(no judge)", fontsize=9, loc="left")
    used |= draw_forest(after, axes[2], _result_overlay(before, judge_output, decision, after, new), show_prompts, P,
                        title=action_summary(decision))
    used.add("new")
    if title:
        fig.suptitle(title, x=0.01, ha="left", fontsize=11, fontweight="bold")
    if decision.terms:
        t = decision.terms
        fig.text(0.5, 0.085, f"objective: fit {t['fit']:.2f}  |  new categories {t['new categories']:.2f}  |  "
                 f"imbalance {t['imbalance']:.2f}  |  disruption {t['disruption']:.2f}  |  total {t['total']:.2f}",
                 ha="center", fontsize=8.5, color=INK2)
    legend(fig, used)
    fig.subplots_adjust(left=0.01, right=0.99, top=0.88, bottom=0.13, wspace=0.05)
    return fig


def compare_view(forests: dict, ideal=None, P: Params | None = None, show_prompts: str = "ids", title: str = ""):
    """Forests side by side; prompts outside their ideal topic (label-independent) in red."""
    from .metrics import misplaced
    fig, axes = plt.subplots(1, len(forests), figsize=(7 * len(forests), 6.5))
    axes = [axes] if len(forests) == 1 else axes
    used: set[str] = set()
    for ax, (name, f) in zip(axes, forests.items()):
        ov = Overlay(misplaced=misplaced(f, ideal) if ideal is not None else set())
        used |= draw_forest(f, ax, ov, show_prompts, P, title=name)
    if title:
        fig.suptitle(title, x=0.01, ha="left", fontsize=11, fontweight="bold")
    legend(fig, used)
    fig.subplots_adjust(left=0.01, right=0.99, top=0.88, bottom=0.08, wspace=0.05)
    return fig


def step_browser(run, P: Params | None = None):
    """A slider over the steps of a run; redraws step_view."""
    import ipywidgets as widgets

    def show(step: int):
        s = run.steps[step - 1]
        step_view(s.before, s.judge, s.decision, s.after, P, title=f"{run.name}, step {step} (intended {s.intended})")
        plt.show()

    return widgets.interact(show, step=widgets.IntSlider(min=1, max=len(run.steps), value=1, description="step"))


def save_storyboard(run, path: Path | None = None, P: Params | None = None) -> Path:
    """One step_view PNG per step: outputs/figures/<run>/step_XX.png."""
    folder = Path(path) if path else FIGURES / run.slug
    folder.mkdir(parents=True, exist_ok=True)
    for s in run.steps:
        fig = step_view(s.before, s.judge, s.decision, s.after, P, title=f"{run.name}, step {s.step} (intended {s.intended})")
        fig.savefig(folder / f"step_{s.step:02d}.png", dpi=110, bbox_inches="tight")
        plt.close(fig)
    return folder


# --- plots for the simulation and the what-if ----------------------------------------------------

METHOD_COLOR = {"ip": "#2a78d6", "judge_argmax": "#eb6834", "chronological": "#008300"}
ACTION_COLOR = {"a": "#cde2fb", "b": "#86b6ef", "c": "#1baf7a", "d": "#eda100", "e": "#e87ba4"}
BLUES = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf",
         "#1c5cab", "#184f95", "#104281", "#0d366b"]


def line_runs(runs, metric: str, ax, ylabel: str, cumulative: bool = False):
    """One line per run; colour by method, line style by judge (oracle solid, noisy dashed, LLM dotted)."""
    for r in runs:
        t = r.table()
        y = t[metric].cumsum() if cumulative else t[metric]
        ls = ":" if r.judge.startswith("llm") else ("--" if "noise=0.0" not in r.judge and r.judge != "none" else "-")
        ax.plot(t["step"], y, color=METHOD_COLOR[r.method], ls=ls, lw=2.2 if r.method == "ip" else 1.6, label=r.name)
    ax.set_xlabel("step")
    ax.set_ylabel(ylabel)
    ax.grid(color="#e1e0d9", lw=0.6)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(fontsize=7, frameon=False)


def heatmap(table, ax, title: str, fmt: str = "{:.2f}", cbar: str = ""):
    """A magnitude grid (pandas pivot: index mu, columns F): one-hue ramp, value in every cell."""
    from matplotlib.colors import LinearSegmentedColormap
    vals = table.values.astype(float)
    im = ax.imshow(vals, cmap=LinearSegmentedColormap.from_list("blues", BLUES), origin="lower", aspect="auto")
    lo, hi = vals.min(), vals.max()
    for i in range(vals.shape[0]):
        for j in range(vals.shape[1]):
            dark = hi > lo and (vals[i, j] - lo) / (hi - lo) > 0.55
            ax.text(j, i, fmt.format(vals[i, j]), ha="center", va="center", fontsize=7, color="white" if dark else INK)
    ax.set_xticks(range(table.shape[1]), [f"{c:.2g}" for c in table.columns])
    ax.set_yticks(range(table.shape[0]), [f"{r:.2g}" for r in table.index])
    ax.set_xlabel("F (fixed cost of a restructure)")
    ax.set_ylabel("mu (cost per moved prompt)")
    ax.set_title(title, fontsize=9, loc="left")
    plt.colorbar(im, ax=ax, fraction=0.046, pad=0.03).set_label(cbar, fontsize=8)


def action_heatmap(table, ax, title: str):
    """The chosen action per cell (a to e), coloured and written in every cell."""
    from matplotlib.colors import ListedColormap
    letters = list(ACTION_COLOR)
    codes = [[letters.index(a) for a in row] for row in table.values]
    ax.imshow(codes, cmap=ListedColormap(list(ACTION_COLOR.values())), vmin=-0.5, vmax=4.5, origin="lower", aspect="auto")
    for i, row in enumerate(table.values):
        for j, a in enumerate(row):
            ax.text(j, i, a, ha="center", va="center", fontsize=9, color=INK)
    ax.set_xticks(range(table.shape[1]), [f"{c:.2g}" for c in table.columns])
    ax.set_yticks(range(table.shape[0]), [f"{r:.2g}" for r in table.index])
    ax.set_xlabel("F (fixed cost of a restructure)")
    ax.set_ylabel("mu (cost per moved prompt)")
    ax.set_title(title, fontsize=9, loc="left")
    present = sorted(set(table.values.ravel()))
    ax.legend([Patch(fc=ACTION_COLOR[a]) for a in present], [f"({a}) {ACTIONS[a]}" for a in present],
              loc="upper left", bbox_to_anchor=(1.02, 1), fontsize=8, frameon=False)
