"""Forest drawings with judge and IP overlays, matplotlib only (plan Section 7).

draw_forest   one forest, top-down: groups on top, topics as boxes, depth downwards
Overlay       marks on a drawing: judge fits, proposals, moves, what the IP adopted or rejected
step_view     input | judge | output for one simulation step
step_card     the same step as a Markdown table, next to the ideal forest and other methods
step_explainer  one step in one figure: the options grouped by kind (add / new topic / move), the judge's
              fit and the IP's gain for each, and one forest per proposed topic and per proposed move
compare_view  several forests side by side, prompts outside their ideal topic in red
action_timeline  the action per step and method, against the intended one
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
from .model import Forest, Topic

FIGURES = ROOT / "outputs" / "figures"
INK, INK2, MUTED = "#0b0b0b", "#52514e", "#898781"
GROUP_FC, TOPIC_FC, EDGE = "#52514e", "#f0efec", "#c3c2b7"
ORANGE, GREEN, GREY, RED = "#eb6834", "#008300", "#a9a8a3", "#d03b3b"
FIT_FC = {1: "#f0efec", 2: "#cde2fb", 3: "#9ec5f4", 4: "#5598e7", 5: "#256abf"}   # light = 1, dark = 5
TARGET_FC = "#fbe1d5"   # light orange: the existing topic the new prompt is added to
NEW_FC = "#d9efd5"      # light green: a topic this step creates
KIND_COLOR = {"add": ORANGE, "new topic": GREEN, "move": "#b8457a", "ip": "#52514e"}   # option kinds
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
    target: str | None = None                               # existing topic that receives the new prompt
    stubs: set[str] = field(default_factory=set)            # placeholder topics standing for collapsed trees


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


def _ghosts(forest: Forest, ov: Overlay, pos: dict, level: float) -> dict[str, tuple[float, float]]:
    """Slots for what is drawn outside the tree: proposals that are not (or no longer) in this
    forest and deleted topics in a row underneath, proposed new groups to the right."""
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
    return ghost


def forest_extent(forest: Forest, overlay: Overlay | None = None, show_prompts: str = "ids") -> tuple[float, float, float, float]:
    """(x0, x1, y0, y1) in data units: the limits draw_forest sets. Times a fixed scale (inches per
    unit) this is the size an axes needs so that the boxes keep their shape."""
    pos, level = _layout(forest, show_prompts)
    pts = list(pos.values()) + list(_ghosts(forest, overlay or Overlay(), pos, level).values())
    xs, ys = [p[0] for p in pts] or [0], [p[1] for p in pts] or [0]
    return min(xs) - 0.7, max(xs) + 0.7, min(ys) - level * 0.7, 0.45


def draw_forest(forest: Forest, ax=None, overlay: Overlay | None = None, show_prompts: str = "ids",
                P: Params | None = None, title: str = ""):
    """Draw one forest. Topics above U get a red border, topics below L a dashed one."""
    ax = ax or plt.gca()
    P, ov = P or Params(), overlay or Overlay()
    pos, level = _layout(forest, show_prompts)
    ax.set_axis_off()
    ax.set_title(title, fontsize=9, loc="left", color=INK)
    used: set[str] = set()
    ghost = _ghosts(forest, ov, pos, level)

    def where(ref: str | None):
        if ref is None:
            return None
        if ref in pos:
            return pos[ref]
        return ghost.get(ref.lower())

    # tree edges; the link of a topic created this step in green
    new_ids = {p.get("id") for p in ov.proposals if p["status"] == "adopted"}
    for t in forest.topics.values():
        (px, py), (cx, cy) = pos[t.parent], pos[t.id]
        new = t.id in new_ids
        ax.plot([px, cx], [py - 0.18, cy + _box_h(forest, t.id, show_prompts) / 2], color=GREEN if new else EDGE,
                lw=1.8 if new else 1, zorder=1)

    # groups
    for g in forest.groups.values():
        cx, cy = pos[g.id]
        adopted = any(ng.get("id") == g.id and ng["status"] == "adopted" for ng in ov.new_groups)
        _box(ax, cx, cy, BOX_W * 1.35, 0.36, GREEN if adopted else GROUP_FC, GREEN if adopted else GROUP_FC,
             lw=2.2 if adopted else 1)
        ax.text(cx, cy, textwrap.fill(g.label, 18), ha="center", va="center", fontsize=7.2, color="white",
                fontweight="bold", zorder=4)
        used |= {"adopted"} if adopted else set()

    # topics
    for t in forest.topics.values():
        cx, cy = pos[t.id]
        h = _box_h(forest, t.id, show_prompts)
        if t.id in ov.stubs:
            _box(ax, cx, cy, BOX_W, h, "white", EDGE, 1.0, (0, (1, 2)))
            ax.text(cx, cy, textwrap.fill(t.label, 16), ha="center", va="center", fontsize=6.8, color=MUTED,
                    style="italic", zorder=4)
            continue
        n_prompts = len(forest.prompts_in(t.id))
        fc = FIT_FC[ov.fits[t.id]] if t.id in ov.fits else TOPIC_FC
        adopted = t.id in new_ids
        ec, lw, ls = EDGE, 1.0, "-"
        if t.id == ov.target:       # an add: the existing topic, orange
            fc, ec, lw = TARGET_FC, ORANGE, 1.8
            used.add("target")
        if adopted:                 # a topic this step creates, green
            fc = NEW_FC
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
        if adopted:
            ax.text(cx - BOX_W / 2 + 0.03, cy + h / 2 + 0.05, "NEW", ha="left", va="bottom", fontsize=5.6, fontweight="bold",
                    color="white", zorder=6, bbox=dict(boxstyle="round,pad=0.2", fc=GREEN, ec="none"))
        dark = t.id != ov.target and t.id in ov.fits and ov.fits[t.id] >= 4
        label = textwrap.wrap(t.label, 16) or [""]
        top = cy + h / 2 - 0.06
        for i, line in enumerate(label):
            ax.text(cx, top - i * LINE_H, line, ha="center", va="top", fontsize=7 if len(line) <= 13 else 6.2,
                    fontweight="bold", color="white" if dark else INK, zorder=4)
        if t.id in ov.fits:   # a badge on the top right corner, clear of the label
            ax.text(cx + BOX_W / 2 - 0.06, cy + h / 2, str(ov.fits[t.id]), ha="center", va="center", fontsize=6.5,
                    fontweight="bold", color=INK, zorder=6,
                    bbox=dict(boxstyle="circle,pad=0.25", fc="white", ec=INK2, lw=0.8))
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

    x0, x1, y0, y1 = forest_extent(forest, ov, show_prompts)
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    return used


LEGEND = {
    "new": Line2D([], [], color=ORANGE, marker="s", ls="", label="new prompt"),
    "target": Patch(fc=TARGET_FC, ec=ORANGE, lw=1.8, label="existing topic the new prompt is added to"),
    "fits": Patch(fc=FIT_FC[4], ec=EDGE, label="judge's fit of the new prompt (shade and badge, 1 to 5)"),
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
    """Input | judge | output for one step, with the objective terms underneath."""
    new = next(iter(set(after.placement) - set(before.placement)))
    text = after.prompts[new].text
    fig, axes = plt.subplots(1, 3, figsize=(21, 7))
    used = draw_forest(before, axes[0], None, show_prompts, P,
                       title=textwrap.fill(f"Input: the forest before step {after.step}, new prompt {new}: {text}", 70))
    if not before.topics:
        axes[0].text(0.5, 0.5, "(empty forest)", ha="center", va="center", fontsize=10, color=MUTED, transform=axes[0].transAxes)
    if judge_output is not None:
        used |= draw_forest(before, axes[1], _judge_overlay(before, judge_output, new), show_prompts, P, title="Judge: fits and proposals")
    else:
        axes[1].set_axis_off()
        axes[1].set_title("(no judge)", fontsize=9, loc="left")
    used |= draw_forest(after, axes[2], _result_overlay(before, judge_output, decision, after, new), show_prompts, P,
                        title="Output: " + action_summary(decision))
    used.add("new")
    if title:
        fig.suptitle(title, x=0.01, ha="left", fontsize=11, fontweight="bold")
    if decision.terms:
        t = decision.terms
        fig.text(0.5, 0.085, "objective: " + "  |  ".join(f"{k} {round(t[k], 2) + 0.0:.2f}" for k in
                                                         ("fit", "new categories", "imbalance", "disruption", "total")),
                 ha="center", fontsize=8.5, color=INK2)
    legend(fig, used)
    fig.subplots_adjust(left=0.01, right=0.99, top=0.88, bottom=0.13, wspace=0.05)
    return fig


def _ref(f: Forest, ref: str) -> str:
    """A judge reference (topic id, group id, NEW_GROUP:x or a proposal name) in words."""
    if ref in f.topics:
        return f.topics[ref].label
    if ref in f.groups:
        return f"{f.groups[ref].label} (group)"
    if ref.startswith(NEW_GROUP):
        return f"new group “{ref[len(NEW_GROUP):]}”"
    return f"“{ref}” (proposed)"


def _moved(f: Forest, m) -> str:
    """The thing a judge move would move, in words."""
    return f"topic {f.topics[m.id].label}" if m.kind == "topic" and m.id in f.topics else m.id


def _count(k: int, word: str) -> str:
    return f"{k} {word}{'s' * (k != 1)}"


def _placed(after: Forest, s, ideal) -> str:
    """Where the new prompt went, with whom, and whether that matches the ideal forest."""
    from .metrics import placed_right, topic_mates
    p = s.prompt.id
    t = after.placement[p].topic
    mates = topic_mates(after, p)
    with_ = "with " + ", ".join(mates) if mates else "alone"
    new = " (new)" if t not in s.before.topics else ""
    return f"{s.prompt.id} → {after.path(t)}{new}, {with_} {'✓' if placed_right(after, ideal, p) else '✗'}"


def step_card(s, ideal, others: dict | None = None) -> str:
    """One step as Markdown: the input (forest, new prompt), the judge's answer, the output, and the
    same step for the ideal forest and for other methods (`others`: method name -> their Step).
    ✓ / ✗: the new prompt shares its topic with exactly the prompts it shares it with ideally."""
    from .metrics import topic_mates
    b, a, d, n = s.before, s.after, s.decision, s.prompt
    rows = []
    size = "empty" if not b.topics else ", ".join(
        [_count(len(b.groups), "group"), _count(len(b.roots()), "tree"), _count(len(b.topics), "topic"),
         _count(len(b.prompts), "prompt")])
    rows.append(("input", f"new prompt **{n.id}**: “{n.text}”<br>forest before: {size}"))
    if s.judge is not None:
        fits = sorted(((e.fit, b.topics[e.topic_id].label) for e in s.judge.existing if e.topic_id in b.topics),
                      key=lambda x: -x[0])
        shown = [f"{label} ({fit})" for fit, label in fits if fit > 1]
        ones = sum(fit == 1 for fit, _ in fits)
        fit_txt = ", ".join(shown) or ""
        if ones:
            fit_txt += f"; {ones} more at (1)" if shown else f"all {ones} at (1)"
        props = "; ".join(f"new topic “{p.name}” (fit {p.fit}) under "
                          + " or ".join(f"{_ref(b, pa.parent)} (parent fit {pa.fit})" for pa in p.parents)
                          for p in s.judge.proposed)
        moves = "; ".join(f"{_moved(b, m)} → {_ref(b, m.to)} ({m.fit})" for m in s.judge.restructure)
        rows.append(("judge", f"fits: {fit_txt or 'no topics yet'}<br>proposes: {props or 'nothing'}<br>"
                              f"moves: {moves or 'none'}"))
    out = [f"({d.action}) {ACTIONS[d.action]}: {_placed(a, s, ideal)}"]
    for p in d.diff.get("moved_prompts", []):
        out.append(f"moved {p} → {a.path(a.placement[p].topic)}")
    for c in d.diff.get("moved_topics", []):
        t = a.topics[c]
        parent = a.topics[t.parent].label if t.parent_kind == "topic" else f"{a.groups[t.parent].label} (group)"
        out.append(f"moved topic {t.label} → under {parent}")
    for c in d.diff.get("deleted_topics", []):
        out.append(f"deleted the empty topic {b.topics[c].label}")
    if s.judge is not None:
        kept = [m for m, ok in d.moves if ok is False]
        if kept and s.argmax is not None:   # judge_argmax ignores every move by design; only the IP rejects
            out.append("rejected moves: " + "; ".join(f"{_moved(b, m)} → {_ref(b, m.to)}" for m in kept))
        if d.rejected and s.argmax is not None:
            out.append("rejected proposals: " + ", ".join(f"“{x}”" for x in d.rejected))
    if d.terms:
        t = d.terms
        out.append("objective: " + ", ".join(f"{k} {round(t[k], 2) + 0.0:+.2f}" for k in ("fit", "new categories", "imbalance", "disruption"))
                   + f" → total {t['total']:.2f}")
    method = "output (IP)" if s.argmax is not None else "output"
    rows.append((method, "<br>".join(out)))
    letter, why = ideal.intended.get(n.id, ("", ""))
    mates = topic_mates(ideal.upto(s.step), n.id)
    rows.append(("ideal", f"({letter}) {ACTIONS.get(letter, '')}: {n.id} → {ideal.forest.path(ideal.topic_of(n.id))}, "
                          f"{'with ' + ', '.join(mates) if mates else 'alone'}"
                          + (f"<br>why: {why}" if why and why != ideal.forest.topics[ideal.topic_of(n.id)].label else "")))
    for name, o in (others or {}).items():
        rows.append((name, f"({o.decision.action}) {ACTIONS[o.decision.action]}: {_placed(o.after, o, ideal)}"))
    esc = lambda x: str(x).replace("|", "\\|")
    head = f"#### Step {s.step} of {len(ideal.arrival)}\n\n| | |\n|---|---|\n"
    return head + "\n".join(f"| **{esc(k)}** | {esc(v)} |" for k, v in rows)


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


# --- options: one forest per option, with what each adds to the objective ------------------------

TERM_COLOR = {"fit": "#2a78d6", "new categories": "#eda100", "imbalance": "#1baf7a", "disruption": "#e87ba4"}
MINUS = "−"


def _num(x: float) -> float:
    return round(x, 2) + 0.0   # no -0.00


def gain_equation(gain: dict) -> str:
    """gain +0.60 = fit +2.00 − new categories 0.80 − imbalance 0.60 (terms at 0 left out)."""
    s = f"gain {_num(gain['total']):+.2f} = fit {_num(gain['fit']):+.2f}"
    for k in ("new categories", "imbalance", "disruption"):
        v = _num(gain[k])
        if v:
            s += f" {'+' if v > 0 else MINUS} {k} {abs(v):.2f}"
    return s.replace("-", MINUS)


def _option_overlay(before: Forest, o, new_prompt: str) -> Overlay:
    a, d = o.after, o.decision
    return Overlay(new_prompt=new_prompt,
                   moved=set(d.diff.get("moved_prompts", [])) | set(d.diff.get("moved_topics", [])),
                   deleted=[(t, before.topics[t].label) for t in d.diff.get("deleted_topics", [])],
                   proposals=[{"name": a.topics[t].label, "fit": 0, "parents": [], "status": "adopted", "id": t}
                              for t in a.topics if t not in before.topics],
                   new_groups=[{"ref": NEW_GROUP + a.groups[g].label, "label": a.groups[g].label, "status": "adopted", "id": g}
                               for g in a.groups if g not in before.groups],
                   target=d.topic_of_n if d.topic_of_n in before.topics else None)


KINDS = {   # option kind -> (heading, where the option comes from)
    "add": ("Add to an existing topic", "the judge rated the new prompt against every existing topic"),
    "new topic": ("Create a new topic", "the judge proposed the topic and rated where it could go"),
    "move": ("Restructure", "the judge proposed moving an old prompt or topic"),
    "ip": ("The IP's own combination", "none of the single options above"),
}
TAG = {"add": "ADD", "new topic": "NEW TOPIC", "move": "RESTRUCTURE", "ip": "IP COMBINATION"}


def options_table(opts: list, ax, ax_w: float, ideal_ok: dict | None = None, unrated: list[str] | None = None,
                  nums: dict[int, int] | None = None) -> None:
    """The options of one step, grouped by kind, read left to right: what happens, the judge's fit,
    then what the IP makes of it (the gain, term by term; diamond = the sum). ax holds the bars;
    ax_w is its width in inches (the columns to its left are placed in inches). ideal_ok: option
    index -> the new prompt lands with its ideal topic-mates. unrated: existing topics rated below
    the cut-off, listed in one line. nums: option index -> the number shown in front (#3), the same
    as on the option's card in step_explainer."""
    ideal_ok, nums = ideal_ok or {}, nums or {}
    fx = lambda inches: inches / ax_w  # noqa: E731  (inches right of the bars' left edge -> axes fraction)
    X_LABEL, X_DOTS, X_PARENT, X_HEAD = fx(-1.75), fx(-1.55), fx(-0.5), fx(-6.0)
    rows: list[tuple] = []          # (kind of row, payload, height in row units)
    for kind in ("add", "new topic", "move", "ip"):
        group = [o for o in opts if o.kind == kind]
        if kind == "ip" and not group:
            continue
        rows.append(("head", (kind, len(group)), 1.15))
        for o in group:
            lines = textwrap.wrap(o.what, 58)
            rows.append(("opt", o, 1.0 if len(lines) == 1 else 1.55))
        if kind == "add" and unrated:
            rows.append(("note", "also rated, below the cut-off (fit 1, unrelated): " + ", ".join(unrated), 0.9))
    total = sum(r[2] for r in rows)
    ys, y = [], total
    for r in rows:
        ys.append(y - r[2] / 2)
        y -= r[2]

    open_ = [o for o in opts if not o.blocked]
    lo = min([0.0] + [sum(min(0, o.gain[k]) for k in TERM_COLOR) for o in open_])
    hi = max([0.0] + [sum(max(0, o.gain[k]) for k in TERM_COLOR) for o in open_])
    pad = (hi - lo) * 0.03 or 0.1
    trans = ax.get_yaxis_transform()   # x in axes fraction, y in data
    for (kind_, payload, h), yc in zip(rows, ys):
        if kind_ == "head":
            kind, count = payload
            name, why = KINDS[kind]
            if kind != "ip" and count == 0:
                why += ": none this step"
            t = ax.text(X_HEAD, yc - 0.05, name, transform=trans, ha="left", va="center", fontsize=9, fontweight="bold",
                        color=KIND_COLOR[kind], clip_on=False)
            r = ax.figure.canvas.get_renderer()
            w = t.get_window_extent(r).width / ax.get_window_extent(r).width
            ax.text(X_HEAD + w + fx(0.1), yc - 0.05, "·  " + why, transform=trans, ha="left", va="center",
                    fontsize=8, color=MUTED, clip_on=False)
            ax.plot([X_HEAD, 1.0], [yc + h / 2 - 0.08] * 2, transform=trans, color=EDGE, lw=0.8, clip_on=False)
            continue
        if kind_ == "note":
            ax.text(X_HEAD + fx(0.15), yc, textwrap.shorten(payload, 150, placeholder=" …"), transform=trans, ha="left",
                    va="center", fontsize=7.5, color=MUTED, style="italic", clip_on=False)
            continue
        o, i = payload, opts.index(payload)
        if o.chosen:
            ax.add_patch(plt.Rectangle((X_HEAD, yc - h / 2 + 0.06), 1.0 - X_HEAD + fx(2.9), h - 0.12, transform=trans,
                                       fc=TOPIC_FC, ec="none", zorder=0, clip_on=False))
        ax.text(X_LABEL, yc, "\n".join(textwrap.wrap(o.what, 58)), transform=trans, ha="right", va="center",
                fontsize=8, color=INK, fontweight="bold" if o.chosen else "normal", clip_on=False, linespacing=1.15)
        if i in nums:
            ax.text(X_HEAD + fx(0.15), yc, f"#{nums[i]}", transform=trans, ha="left", va="center", fontsize=8,
                    color=INK2, fontweight="bold", clip_on=False)
        if o.fit is not None:
            for k in range(5):
                ax.plot(X_DOTS + fx(0.17) * k, yc, transform=trans, marker="o", ms=5.2, ls="", clip_on=False,
                        color=INK2 if k < o.fit else "white", mec=INK2 if k < o.fit else EDGE, mew=0.9)
        if o.parent_fit is not None:
            ax.text(X_PARENT, yc, f"parent {o.parent_fit}", transform=trans, ha="left", va="center", fontsize=7.5,
                    color=INK2, clip_on=False)
        if o.blocked:
            ax.text(0.01, yc, f"not possible: {o.blocked}", transform=trans, ha="left", va="center", fontsize=7.5,
                    color=RED, clip_on=False, zorder=5, bbox=dict(boxstyle="square,pad=0.15", fc="white", ec="none"))
            ax.text(1.02, yc, "—", transform=trans, va="center", ha="left", fontsize=8.5, color=RED, clip_on=False)
            continue
        pos = neg = 0.0
        for k, color in TERM_COLOR.items():
            v = o.gain[k]
            if abs(v) < 1e-9:
                continue
            ax.barh(yc, abs(v), left=pos if v > 0 else neg + v, height=0.62, color=color, edgecolor="white", lw=1.5, zorder=2)
            pos, neg = (pos + v, neg) if v > 0 else (pos, neg + v)
        ax.plot(o.gain["total"], yc, marker="D", ms=6.5, color=INK, mec="white", mew=1.5, ls="", zorder=4)
        ax.text(1.02, yc, f"{_num(o.gain['total']):+.2f}".replace("-", MINUS), transform=trans, va="center", ha="left",
                fontsize=8.5, color=INK, fontweight="bold" if o.chosen else "normal", clip_on=False)
        marks = ("IP's choice" if o.chosen else "") + ("   ✓ placed right" if ideal_ok.get(i) else "")
        if marks:
            ax.text(1.02 + fx(0.55), yc, marks.strip() if not o.chosen else marks, transform=trans, va="center", ha="left",
                    fontsize=8, color=INK, fontweight="bold" if o.chosen else "normal", clip_on=False)
    # column heads
    top = total + 0.55
    for x, label, ha in ((X_LABEL, "what happens", "right"), (X_DOTS - fx(0.05), "judge's fit (1-5)", "left"),
                         (0.5, "IP: change in the objective (gain)", "center"), (1.02, "gain", "left")):
        ax.text(x, top, label, transform=trans, ha=ha, va="bottom", fontsize=8, color=MUTED, clip_on=False)
    ax.axvline(0, color=INK2, lw=0.8, zorder=3)
    ax.set_xlim(lo - pad, hi + pad)
    ax.set_ylim(0, total)
    ax.set_yticks([])
    ax.grid(axis="x", color="#e1e0d9", lw=0.6, zorder=0)
    ax.set_axisbelow(True)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.spines["bottom"].set_color(EDGE)
    ax.tick_params(axis="x", labelsize=7.5, colors=INK2)
    handles = [Patch(fc=c, ec="white", label=k) for k, c in TERM_COLOR.items()]
    handles.append(Line2D([], [], marker="D", ms=6.5, color=INK, mec="white", ls="", label="gain (the sum)"))
    ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.09), ncol=5, fontsize=7.5, frameon=False,
              handlelength=1.2, columnspacing=1.0)


SECTIONS = {   # option kind -> (heading, what its cards show) for the cards under the table
    "new topic": ("New topics the judge proposed", "one card per proposed topic and each parent the judge rated for it"),
    "move": ("Moves the judge proposed", "one card per proposed move of an old prompt or topic"),
    "ip": ("The IP's own combination", "none of the single options above"),
}
SCALE = 1.1   # inches per layout unit for the trees in step_explainer: a box is always wide enough for its label


def _focus(before: Forest, after: Forest) -> tuple[Forest, set[str]]:
    """The part of `after` that an option changes: every tree whose topics or prompts differ from
    `before`, inside its group. The group's other trees collapse into one stub topic ('+3 other
    trees'); groups without a change are left out. Returns the forest and the stub ids."""
    def sig(f: Forest, r: str) -> tuple:
        sub = set(f.subtree(r))
        return ({(t, f.topics[t].parent) for t in sub},
                {(p, pl.topic) for p, pl in f.placement.items() if pl.topic in sub})
    old_roots = set(before.roots())
    changed = {r for r in after.roots() if r not in old_roots or sig(before, r) != sig(after, r)}
    out, stubs = Forest(prompts=after.prompts, step=after.step), set()
    for g, grp in after.groups.items():
        roots = after.roots(g)
        keep = {r for r in roots if r in changed}
        if not keep:
            continue
        out.groups[g] = grp
        out.topics.update({t: topic for t, topic in after.topics.items() if after.group_of(t) == g and after.root_of(t) in keep})
        rest = len(roots) - len(keep)
        if rest:
            sid = f"__more_{g}"
            out.topics[sid] = Topic(sid, f"+{rest} other tree{'s' * (rest != 1)}", g, "group", 0.0)
            stubs.add(sid)
    out.placement = {p: pl for p, pl in after.placement.items() if pl.topic in out.topics}
    return out, stubs


def step_explainer(s, ideal=None, P: Params | None = None, show_prompts: str = "ids", width: float = 14.0):
    """One step explained in one figure, top to bottom:
      1. the new prompt, the ideal answer and the IP's;
      2. the forest the judge saw, each topic shaded by the judge's fit of the new prompt (these are
         the add options; orange: where the IP adds it);
      3. every option the judge opened, numbered, grouped by kind, with the judge's fit and the IP's
         gain (options_table);
      4. one card per proposed new topic (once per parent the judge rated) and per proposed move:
         the tree(s) the option changes in the best forest that contains it, the other trees of
         that group collapsed. An option a hard limit rules out is drawn as it would be without
         that limit, in a red dashed card.
    Every tree is drawn at the same scale (SCALE inches per unit), so boxes never get squeezed;
    the figure grows downwards instead. `s` is a simulate.Step of an IP run."""
    from .ip import options
    from .metrics import placed_right
    P = P or Params()
    n, before = s.prompt, s.before
    opts = options(before, n, s.judge, s.step, P)
    ideal_ok = ({i: not o.blocked and placed_right(o.after, ideal, n.id) for i, o in enumerate(opts)}
                if ideal is not None else {})
    order = [o for k in ("add", "new topic", "move", "ip") for o in opts if o.kind == k]
    nums = {opts.index(o): k for k, o in enumerate(order, 1)}
    offered = {o.decision.topic_of_n for o in opts if o.kind == "add"}
    fits = {e.topic_id: e.fit for e in s.judge.existing}
    unrated = [before.topics[t].label for t in before.topics if t not in offered and fits.get(t, 1) <= 1]
    chosen = next(o for o in opts if o.chosen)
    W, M, PAD, GAP, LH = width, 0.15, 0.12, 0.25, 0.17   # inches: width, margin, card padding, gap, title line

    # pass 1: sizes and positions in inches, y measured from the top
    def tree_size(f: Forest, ov: Overlay, room: float) -> tuple[float, float, float]:
        x0, x1, y0, y1 = forest_extent(f, ov, show_prompts)
        k = min(SCALE, room / (x1 - x0))
        return (x1 - x0) * k, (y1 - y0) * k, k

    target = chosen.decision.topic_of_n if chosen.kind == "add" else None
    top = chosen.after if target else before      # an add changes nothing else: show the prompt in its topic
    before_ov = Overlay(new_prompt=n.id, fits={t: fits.get(t, 1) for t in before.topics}, target=target)
    bw, bh, _ = tree_size(top, before_ov, W - 2 * M)
    adds = [nums[i] for i, o in enumerate(opts) if o.kind == "add"]
    before_title = (f"The forest the judge saw. Shade and badge: the judge's fit of {n.id} to each topic (1 to 5); "
                    f"these are the add options" + (f" (#{adds[0]}–#{adds[-1]} in the table)" if len(adds) > 1 else "")
                    + (f". Orange: the IP's choice, {n.id} added to an existing topic." if target else "."))
    y = 0.95
    y_before = y
    y += 0.3 + bh + 0.35
    n_rows = 3 + len(opts) + (1 if unrated else 0) + any(o.kind == "ip" for o in opts)
    table_h = 0.34 * n_rows + 0.9
    y_table = y
    y += table_h + 0.25

    blocks = []   # (y, kind, payload)
    for kind, (name, why) in SECTIONS.items():
        group = [o for o in order if o.kind == kind]
        if kind == "ip" and not group:
            continue
        blocks.append((y, "head", (name, why if group else "the judge proposed none this step")))
        y += 0.5
        x, row_h = M, 0.0
        for o in group:
            i = opts.index(o)
            f, stubs = _focus(before, o.after)
            ov = _option_overlay(before, o, n.id)
            ov.stubs = stubs
            tw, th, k = tree_size(f, ov, W - 2 * M - 2 * PAD)
            cw = max(tw + 2 * PAD, 3.7)
            chars = int((cw - 2 * PAD) * 14.5)
            head = f"#{nums[i]}  {TAG[o.kind]}" + ("   ·   IP's choice" if o.chosen else "") + ("   ·   ✓ placed right" if ideal_ok.get(i) else "")
            lines = [(head, KIND_COLOR[o.kind], "bold")]
            lines += [(ln, INK, "normal") for ln in textwrap.wrap(o.what, chars)]
            if o.fit is not None:
                lines.append((f"judge: fit {o.fit}" + (f", parent {o.parent_fit}" if o.parent_fit else ""), INK2, "normal"))
            if o.blocked:
                lines += [(ln, RED, "bold") for ln in textwrap.wrap(f"not possible: {o.blocked}", chars)]
                lines += [(ln, RED, "normal") for ln in textwrap.wrap("without that limit: " + gain_equation(o.gain), chars)]
            else:
                lines += [(ln, INK2, "normal") for ln in textwrap.wrap(gain_equation(o.gain), chars)]
            ch = PAD + len(lines) * LH + 0.1 + th + PAD
            if x > M and x + cw > W - M:
                y += row_h + GAP
                x, row_h = M, 0.0
            blocks.append((y, "card", dict(o=o, x=x, w=cw, h=ch, lines=lines, f=f, ov=ov, tw=tw, th=th)))
            x += cw + GAP
            row_h = max(row_h, ch)
        y += row_h + (GAP if group else 0.0)
    H = y + 0.55

    # pass 2: draw
    fig = plt.figure(figsize=(W, H))
    inch = fig.dpi_scale_trans
    text = lambda x, yy, t, **kw: fig.text(x, H - yy, t, transform=inch, va="top", **kw)  # noqa: E731
    axes_at = lambda x, yy, w, h: fig.add_axes([x / W, (H - yy - h) / H, w / W, h / H])  # noqa: E731

    text(M, 0.25, textwrap.shorten(f"Step {s.step}  ·  new prompt {n.id}: “{n.text}”", 140, placeholder=" …"),
         fontsize=11.5, fontweight="bold", color=INK)
    sub = f"IP: ({s.decision.action}) {ACTIONS[s.decision.action]}"
    if ideal is not None:
        letter = ideal.intended.get(n.id, ("", ""))[0]
        sub = f"ideal: ({letter}) {ACTIONS.get(letter, '')} → {ideal.forest.path(ideal.topic_of(n.id))}     " + sub
    text(M, 0.58, sub, fontsize=9.5, color=INK2)

    text(M, y_before, textwrap.fill(before_title, 175), fontsize=9, color=INK)
    fax = axes_at(M, y_before + 0.3, bw, bh)
    used = draw_forest(top, fax, before_ov, show_prompts, P)
    if not before.topics:
        fax.text(0.5, 0.5, "(empty forest)", ha="center", va="center", fontsize=10, color=MUTED, transform=fax.transAxes)

    ax_w = 4.6
    ax = axes_at(6.25, y_table + 0.45, ax_w, table_h - 0.95)
    options_table(opts, ax, ax_w, ideal_ok, unrated, nums)

    r = fig.canvas.get_renderer()
    for yy, kind, b in blocks:
        if kind == "head":
            name, why = b
            fig.add_artist(Line2D([M, W - M], [H - yy] * 2, transform=inch, color=EDGE, lw=0.8))
            t = text(M, yy + 0.1, name, fontsize=10.5, fontweight="bold", color=INK)
            w = t.get_window_extent(r).width / fig.dpi
            text(M + w + 0.08, yy + 0.12, "·  " + why, fontsize=9, color=MUTED)
            continue
        o = b["o"]
        ec, lw, ls = (INK2, 1.8, "-") if o.chosen else (RED, 1.2, (0, (4, 3))) if o.blocked else (EDGE, 0.9, "-")
        fig.add_artist(FancyBboxPatch((b["x"], H - yy - b["h"]), b["w"], b["h"], transform=inch, fc="white", ec=ec,
                                      lw=lw, ls=ls, boxstyle="round,pad=0,rounding_size=0.06", zorder=0))
        for j, (ln, color, weight) in enumerate(b["lines"]):
            text(b["x"] + PAD, yy + PAD + j * LH, ln, fontsize=8.5, color=color, fontweight=weight)
        pax = axes_at(b["x"] + PAD, yy + PAD + len(b["lines"]) * LH + 0.1, b["tw"], b["th"])
        used |= draw_forest(b["f"], pax, b["ov"], show_prompts, P)

    own = {"adopted": Patch(fc=NEW_FC, ec=GREEN, lw=2, label="NEW: topic or group created by this option"),
           "moved": Patch(fc="white", ec=GREEN, lw=2, label="moved by this option")}
    handles = [own.get(k, LEGEND[k]) for k in LEGEND if k in used | {"new"}]
    handles.append(Patch(fc="white", ec=MUTED, ls=(0, (1, 2)), label="other trees, unchanged (collapsed)"))
    fig.legend(handles=handles, loc="lower center", ncol=min(4, len(handles)), fontsize=8, frameon=False,
               bbox_to_anchor=(0.5, 0.0), bbox_transform=fig.transFigure)
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
    """One line per run; colour by method; with several judges, line style by judge (oracle solid,
    noisy dashed, LLM dotted)."""
    mixed = len({r.judge for r in runs if r.judge != "none"}) > 1
    for r in runs:
        t = r.table()
        y = t[metric].cumsum() if cumulative else t[metric]
        ls = "-" if not mixed else (":" if r.judge.startswith("llm") else ("--" if "noise=0.0" not in r.judge and r.judge != "none" else "-"))
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


def action_timeline(rows: dict, ok: dict, ax, title: str = ""):
    """One row per method (rows: name -> action letters per step), one cell per step, coloured by the
    action. A hatched cell: the new prompt did not land with the prompts it shares a topic with in the
    ideal forest (ok: name -> booleans per step; leave a row out for no marks)."""
    from matplotlib.patches import Rectangle
    names = list(rows)
    steps = max(len(v) for v in rows.values())
    for i, name in enumerate(names):
        y = len(names) - 1 - i
        for j, a in enumerate(rows[name]):
            bad = name in ok and not ok[name][j]
            ax.add_patch(Rectangle((j + 0.05, y + 0.08), 0.9, 0.84, fc=ACTION_COLOR[a], ec=INK2 if bad else "none",
                                   hatch="////" if bad else None, lw=0))
            ax.text(j + 0.5, y + 0.5, a, ha="center", va="center", fontsize=8.5, color=INK,
                    bbox=dict(boxstyle="round,pad=0.15", fc=ACTION_COLOR[a], ec="none") if bad else None)
    ax.set_xlim(0, steps)
    ax.set_ylim(0, len(names))
    ax.set_xticks([j + 0.5 for j in range(steps)], [str(j + 1) for j in range(steps)], fontsize=7.5)
    ax.set_yticks([len(names) - 1 - i + 0.5 for i in range(len(names))], names, fontsize=8.5)
    ax.tick_params(length=0)
    ax.spines[:].set_visible(False)
    ax.set_xlabel("step")
    if title:
        ax.set_title(title, fontsize=9, loc="left")
    present = sorted({a for v in rows.values() for a in v})
    handles = [Patch(fc=ACTION_COLOR[a], label=f"({a}) {ACTIONS[a]}") for a in present]
    handles.append(Patch(fc="white", ec=INK2, hatch="////", lw=0, label="new prompt not with its ideal topic-mates"))
    ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(0, -0.22), ncol=len(handles), fontsize=8, frameon=False)
