"""Steps 4, 5 and 7: every number of out/report.md, written to out/results.json and printed.

  uv run python -m thinking_filter.evaluate          # out/results.json

4. history: the judge with and without the tutor's message, on the reply items
5. sonnet: the judge against Claude Sonnet 5 on the stratified sample
7. filter: held-out (5-fold) filter against the judge, next to the word rules and the prior;
   word by word; prefixes the judge also rated; online learning; the student with a habit.
"""
import json
import math
import random
import sys
from collections import Counter, defaultdict

import numpy as np

from . import design, frontend, linter_set, nb
from .cv import featurize, training_set
from .files import HABIT, LABELS, OUT, RESULTS, SONNET, SYNTHETIC, WEIGHTS, read_jsonl, write_json

C = frontend.constants()
OWN_FROM, AI_UP_TO = C["OWN_FROM"], C["AI_UP_TO"]
LABS = ["ai", "together", "own"]


def lab(p: float) -> str:
    """thinkingMode() in frontend/src/lib/modes.ts."""
    return "own" if p >= OWN_FROM else "ai" if p <= AI_UP_TO else "together"


def confusion(true: list[str], pred: list[str], cats=LABS) -> dict:
    m = {t: {p: 0 for p in cats} for t in cats}
    for t, p in zip(true, pred):
        m[t][p] += 1
    return m


def kappa(true: list, pred: list) -> float:
    n = len(true)
    po = sum(t == p for t, p in zip(true, pred)) / n
    ct, cp = Counter(true), Counter(pred)
    pe = sum(ct[c] * cp[c] for c in set(true) | set(pred)) / n / n
    return (po - pe) / (1 - pe) if pe < 1 else 1.0


def label_stats(judge_pct: list[float], pred_pct: list[float] | None = None, pred_labels: list[str] | None = None) -> dict:
    jl = [lab(p) for p in judge_pct]
    pl = pred_labels if pred_labels is not None else [lab(p) for p in pred_pct]
    out = {"agree": sum(a == b for a, b in zip(jl, pl)) / len(jl), "kappa": kappa(jl, pl), "confusion": confusion(jl, pl)}
    if pred_pct is not None:
        e = np.abs(np.array(pred_pct) - np.array(judge_pct))
        out |= {"mae": float(e.mean()), "rmse": float(np.sqrt((e ** 2).mean()))}
    return out


def r(x: float, d: int = 3) -> float:
    return round(float(x), d)


def calibrated(m: nb.Model) -> nb.Model:
    """The same counts with the Brier-optimal ("calibrated") alpha and beta of selection.json: the
    alternative weighed in the report."""
    c = json.loads((OUT / "selection.json").read_text())["calibrated"]
    return nb.Model(alpha=c["alpha"], beta=c["beta"], prior=m.prior, counts=m.counts, totals=m.totals)


def label_flips(labels_per_word: list[str]) -> int:
    """How often the label changes while the draft is typed, checked at every word end (as
    flips() in frontend/eval/linter.eval.ts)."""
    return sum(a != b for a, b in zip(labels_per_word, labels_per_word[1:]))


def flip_stats(per_item: list[list[str]]) -> dict:
    f = np.array([label_flips(x) for x in per_item])
    return {"mean": r(f.mean(), 2), "share_at_least_one": r((f > 0).mean()), "share_more_than_two": r((f > 2).mean())}


def rules_per_word(texts: list[str]) -> list[list[str]]:
    """The word rules' label after every word of every text (one bridge call)."""
    prefixes = [[t[:e] for e in design.chunk_ends(t)] for t in texts]
    modes = iter(x["mode"] for x in frontend.word_rules([p for ps in prefixes for p in ps]))
    return [[next(modes) for _ in ps] for ps in prefixes]


# --- 4. with or without history ------------------------------------------------------------------

def history(items: list[dict], labels: dict) -> dict:
    rows = []
    for it in items:
        if not it["tutor"]:
            continue
        a, b = labels.get((it["id"], "without", None)), labels.get((it["id"], "with", None))
        if a and b and "percent" in a and "percent" in b:
            rows.append({"id": it["id"], "kind": it["kind"], "target": it["target"], "tutor": it["tutor"], "text": it["text"],
                         "asked": nb.tutor_asked(it["tutor"]), "without": a["percent"], "with": b["percent"]})
    d = np.array([x["with"] - x["without"] for x in rows])
    flips = [x for x in rows if lab(x["with"]) != lab(x["without"])]
    by_kind = defaultdict(list)
    for x in rows:
        by_kind[x["kind"]].append(x)
    target = lambda x: (x["target"] - 1) / 4  # noqa: E731 - the generator's aim as a percent
    out = {
        "n": len(rows),
        "mean_abs_diff": r(np.abs(d).mean()), "mean_diff_with_minus_without": r(d.mean()),
        "share_abs_diff_over_0.1": r((np.abs(d) > 0.1).mean()), "share_abs_diff_over_0.25": r((np.abs(d) > 0.25).mean()),
        "label_flips": len(flips), "label_flip_share": r(len(flips) / len(rows)),
        "flip_matrix_without_to_with": confusion([lab(x["without"]) for x in rows], [lab(x["with"]) for x in rows]),
        "tutor_asked_share": r(np.mean([x["asked"] for x in rows])),
        "by_kind": {k: {"n": len(v), "without": r(np.mean([x["without"] for x in v])), "with": r(np.mean([x["with"] for x in v])),
                        "flips": sum(lab(x["with"]) != lab(x["without"]) for x in v)} for k, v in sorted(by_kind.items())},
        "vs_generator_target": {c: {"mae": r(np.mean([abs(x[c] - target(x)) for x in rows])),
                                    "label_agree": r(np.mean([lab(x[c]) == lab(target(x)) for x in rows]))} for c in ("without", "with")},
        "biggest": [{k: (r(v) if isinstance(v, float) else v) for k, v in x.items()} for x in sorted(rows, key=lambda x: -abs(x["with"] - x["without"]))[:12]],
    }
    return out


# --- the judge's labels overall -----------------------------------------------------------------------

def judge_overview(items: list[dict], labels: dict) -> dict:
    all_rows = [v for k, v in labels.items()]
    rejected = [v for v in all_rows if "error" in v]
    train = [(it, labels[(it["id"], design.condition_for(it), None)]) for it in items]
    ok = [(it, l) for it, l in train if "percent" in l]
    by_kind = defaultdict(list)
    for it, l in ok:
        by_kind[it["kind"]].append(l["percent"])
    argmax = Counter(int(np.argmax(l["probs"])) + 1 for _, l in ok)
    return {
        "label_rows": len(all_rows), "rejected": len(rejected), "rejected_examples": [{"id": v["id"], "error": v["error"]} for v in rejected[:5]],
        "training_items": len(ok), "mass_mean": r(np.mean([l["mass"] for _, l in ok]), 4), "mass_min": r(min(l["mass"] for _, l in ok), 4),
        "top_level_counts": {str(k): argmax[k] for k in range(1, 6)},
        "label_counts": dict(Counter(lab(l["percent"]) for _, l in ok)),
        "mean_top_probability": r(np.mean([max(l["probs"]) for _, l in ok])),
        "by_kind": {k: {"n": len(v), "mean": r(np.mean(v)), "min": r(min(v)), "max": r(max(v))} for k, v in sorted(by_kind.items())},
        "target_label_agree": r(np.mean([lab(l["percent"]) == lab((it["target"] - 1) / 4) for it, l in ok])),
    }


# --- 5. the judge against Sonnet ------------------------------------------------------------------

def sonnet_check(items: list[dict], labels: dict) -> dict | None:
    if not SONNET.exists():
        return None
    by_id = {it["id"]: it for it in items}
    rows = []
    for s in read_jsonl(SONNET):
        lab_row = labels[(s["id"], s["cond"], None)]
        if "percent" not in lab_row:
            continue
        it = by_id[s["id"]]
        rows.append({"id": s["id"], "kind": it["kind"], "text": it["text"], "tutor": it["tutor"] if s["cond"] == "with" else None,
                     "judge_pct": lab_row["percent"], "judge_top": int(np.argmax(lab_row["probs"])) + 1, "judge_top_p": max(lab_row["probs"]),
                     "sonnet": s["rating"], "sonnet_pct": (s["rating"] - 1) / 4})
    jt, st = [x["judge_top"] for x in rows], [x["sonnet"] for x in rows]
    jp, sp = np.array([x["judge_pct"] for x in rows]), np.array([x["sonnet_pct"] for x in rows])
    conf5 = {str(a): {str(b): 0 for b in range(1, 6)} for a in range(1, 6)}
    for a, b in zip(jt, st):
        conf5[str(a)][str(b)] += 1
    rank = lambda v: np.argsort(np.argsort(v, kind="stable"), kind="stable")  # noqa: E731
    big = sorted(rows, key=lambda x: -abs(x["judge_pct"] - x["sonnet_pct"]))[:15]
    by_kind = defaultdict(list)
    for x in rows:
        by_kind[x["kind"]].append(x)
    return {
        "n": len(rows),
        "exact": r(np.mean([a == b for a, b in zip(jt, st)])), "within_one": r(np.mean([abs(a - b) <= 1 for a, b in zip(jt, st)])),
        "pearson_pct": r(np.corrcoef(jp, sp)[0, 1]), "spearman_pct": r(np.corrcoef(rank(jp), rank(sp))[0, 1]),
        "mean_abs_pct_diff": r(np.abs(jp - sp).mean()), "mean_judge_minus_sonnet": r((jp - sp).mean()),
        "labels": {k: v for k, v in label_stats(list(jp), list(sp)).items() if k in ("agree", "kappa", "confusion")},
        "kappa_5": r(kappa(jt, st)),
        "confusion_judge_top_rows_sonnet_cols": conf5,
        "by_kind": {k: {"n": len(v), "judge": r(np.mean([x["judge_pct"] for x in v])), "sonnet": r(np.mean([x["sonnet_pct"] for x in v])),
                        "label_agree": r(np.mean([lab(x["judge_pct"]) == lab(x["sonnet_pct"]) for x in v]))} for k, v in sorted(by_kind.items())},
        "biggest": [{k: (r(v) if isinstance(v, float) else v) for k, v in x.items()} for x in big],
    }


# --- 7. the filter -------------------------------------------------------------------------------

def shipped_params() -> dict:
    sel = json.loads((OUT / "selection.json").read_text())
    f = sel["final"]
    return {"alpha": f["alpha"], "beta": f["beta"], "min_docs": f["min_docs"], "top_k": f["top_k"]}


def feats_of(it: dict, text: str | None = None) -> list[str]:
    """Features of an item's text (or of a draft of it). The word rules' results are memoised: callers
    prefetch them for many texts at once with frontend.word_rules()."""
    return featurize([(it["text"] if text is None else text, nb.tutor_asked(it["tutor"]))])[0]


def prefetch_prefixes(texts: list[str]) -> None:
    """Run the word rules once on every word-end prefix of these texts."""
    frontend.word_rules([t[:e] for t in texts for e in design.chunk_ends(t)])


def fold_models(items: list[dict], q: np.ndarray, p: dict) -> tuple[list[int], list[nb.Model]]:
    fold = design.folds(items)
    frontend.word_rules([it["text"] for it in items])
    fl = [feats_of(it) for it in items]
    models = []
    for k in range(design.FOLDS):
        tr = [i for i in range(len(items)) if fold[i] != k]
        models.append(nb.fit([fl[i] for i in tr], [list(q[i]) for i in tr], p["alpha"], p["beta"], p["min_docs"], p["top_k"]))
    return fold, models


def filter_eval(items, q, fold, models) -> tuple[dict, dict]:
    pct = list(q @ np.array(nb.LEVEL_WEIGHTS))
    bel = [nb.belief(feats_of(it), models[fold[i]]) for i, it in enumerate(items)]
    est = [nb.estimate(b) for b in bel]
    cert = [nb.certainty(b) for b in bel]
    prior_est = [nb.estimate(nb.belief([], models[fold[i]])) for i in range(len(items))]
    rules = frontend.word_rules([it["text"] for it in items])
    rule_share = [x["share"] for x in rules]
    ce = float(-np.mean([sum(qk * math.log(max(bk, 1e-300)) for qk, bk in zip(q[i], bel[i])) for i in range(len(items))]))

    def per_group(key):
        g = defaultdict(list)
        for i, it in enumerate(items):
            g[key(it)].append(i)
        return {k: {"n": len(ix), "judge": r(np.mean([pct[i] for i in ix])),
                    "filter_mae": r(np.mean([abs(est[i] - pct[i]) for i in ix])), "rules_mae": r(np.mean([abs(rule_share[i] - pct[i]) for i in ix])),
                    "prior_mae": r(np.mean([abs(prior_est[i] - pct[i]) for i in ix])),
                    "filter_label_agree": r(np.mean([lab(est[i]) == lab(pct[i]) for i in ix])),
                    "rules_label_agree": r(np.mean([rules[i]["mode"] == lab(pct[i]) for i in ix]))} for k, ix in sorted(g.items(), key=lambda kv: str(kv[0]))}

    certs = np.array(cert)
    errs = np.abs(np.array(est) - np.array(pct))
    tert = np.quantile(certs, [1 / 3, 2 / 3])
    worst = sorted(range(len(items)), key=lambda i: -errs[i])[:15]
    out = {
        "n": len(items), "cross_entropy": r(ce, 4),
        "filter": label_stats(pct, est), "rules_share": label_stats(pct, rule_share),
        "rules_linter_label": {k: v for k, v in label_stats(pct, pred_labels=[x["mode"] for x in rules]).items()},
        "prior": label_stats(pct, prior_est),
        "prior_estimate_range": [r(min(prior_est)), r(max(prior_est))],
        "by_kind": per_group(lambda it: it["kind"]),
        "by_reply": per_group(lambda it: "reply" if it["tutor"] else "first message"),
        "by_hard": per_group(lambda it: "hard kind" if it["hard"] else "other kind"),
        "by_lang": per_group(lambda it: it.get("lang", "en")),
        "by_round": per_group(lambda it: f"round {it.get('round', 1)}"),
        "combined": combinations(pct, est, rules),
        "certainty": {"mean": r(certs.mean()), "tertiles": [r(t) for t in tert],
                      "mae_low_mid_high": [r(errs[certs <= tert[0]].mean()), r(errs[(certs > tert[0]) & (certs <= tert[1])].mean()), r(errs[certs > tert[1]].mean())]},
        "worst": [{"id": items[i]["id"], "kind": items[i]["kind"], "text": items[i]["text"], "judge": r(pct[i]), "filter": r(est[i]), "rules": r(rule_share[i])} for i in worst],
    }
    for key in ("filter", "rules_share", "prior"):
        for k in ("mae", "rmse", "agree", "kappa"):
            out[key][k] = r(out[key][k])
    out["rules_linter_label"]["agree"] = r(out["rules_linter_label"]["agree"])
    out["rules_linter_label"]["kappa"] = r(out["rules_linter_label"]["kappa"])
    return out, {"est": est, "pct": pct}


def combinations(judge_pct: list[float], est: list[float], rules: list[dict], labels: list[str] | None = None) -> dict:
    """Two simple ways to use filter and rules together, as reference points: the mean of the two
    estimates, and the rules' label when the linter is at least 70 % sure, else the filter's."""
    mean = [(e + x["share"]) / 2 for e, x in zip(est, rules)]
    switch_est = [x["share"] if x["confidence"] >= nb.RULE_SURE else e for e, x in zip(est, rules)]
    switch_lab = [x["mode"] if x["confidence"] >= nb.RULE_SURE else lab(e) for e, x in zip(est, rules)]
    sure = float(np.mean([x["confidence"] >= nb.RULE_SURE for x in rules]))
    if labels is not None:  # a set with its own labels (Leon's): label agreement only
        return {"mean": [lab(m) for m in mean], "switch": switch_lab, "share_rules_sure": r(sure)}
    out = {"mean of filter and draftShare": label_stats(judge_pct, mean),
           "rules if linter >= 0.7 sure, else filter": label_stats(judge_pct, pred_labels=switch_lab) | {"mae": float(np.mean(np.abs(np.array(switch_est) - np.array(judge_pct))))},
           "share_rules_sure": r(sure)}
    for v in out.values():
        if isinstance(v, dict):
            for k in ("mae", "rmse", "agree", "kappa"):
                if k in v:
                    v[k] = r(v[k])
    return out


def word_by_word(items, fold, models) -> dict:
    sample = design.word_by_word_sample(items)
    prefetch_prefixes([items[i]["text"] for i in sample])
    settle, frac, n_words, gap3, gap23, cert_at = [], [], [], [], [], defaultdict(list)
    examples, labs, labs1, steps, steps1 = [], [], [], [], []
    for i in sample:
        it = items[i]
        ends = design.chunk_ends(it["text"])
        m = models[fold[i]]
        bels = [nb.belief(feats_of(it, it["text"][:e]), m) for e in ends]
        ests = [nb.estimate(b) for b in bels]
        ests1 = [nb.estimate(nb.belief(feats_of(it, it["text"][:e]), calibrated(m))) for e in ends]
        labs.append([lab(x) for x in ests])
        labs1.append([lab(x) for x in ests1])
        steps += [abs(a - b) for a, b in zip(ests, ests[1:])]
        steps1 += [abs(a - b) for a, b in zip(ests1, ests1[1:])]
        final = ests[-1]
        s = len(ests)
        while s > 1 and abs(ests[s - 2] - final) <= 0.2:
            s -= 1
        n = len(ests)
        settle.append(s)
        frac.append(s / n)
        n_words.append(n)
        third, two = max(1, round(n / 3)), max(1, round(2 * n / 3))
        gap3.append(abs(ests[third - 1] - final))
        gap23.append(abs(ests[two - 1] - final))
        for name, j in (("word 1", 0), ("1/3", third - 1), ("2/3", two - 1), ("full", n - 1)):
            cert_at[name].append(nb.certainty(bels[j]))
        if len(examples) < 6 and 6 <= n <= 14:
            examples.append({"id": it["id"], "kind": it["kind"], "text": it["text"], "estimates": [r(x, 2) for x in ests]})
    settle = np.array(settle)
    return {
        "n": len(sample), "words_median": float(np.median(n_words)),
        "settle_word_median": float(np.median(settle)), "settle_word_mean": r(settle.mean(), 2),
        "settled_by_word": {str(k): r((settle <= k).mean()) for k in (1, 2, 3, 5, 8)},
        "settle_fraction_median": r(np.median(frac)),
        "abs_gap_to_final_at_1/3": r(np.mean(gap3)), "abs_gap_to_final_at_2/3": r(np.mean(gap23)),
        "certainty_mean": {k: r(np.mean(v)) for k, v in cert_at.items()},
        "mean_abs_step_per_word": {"filter": r(np.mean(steps)), "filter calibrated": r(np.mean(steps1))},
        "label_flips": {"filter": flip_stats(labs), "filter calibrated": flip_stats(labs1),
                        "rules": flip_stats(rules_per_word([items[i]["text"] for i in sample]))},
        "examples": examples,
    }


def prefixes_check(items, labels, fold, models) -> dict:
    sample = design.prefix_sample(items)
    frontend.word_rules([t for i in sample for t in (*design.prefixes(items[i]["text"]).values(), items[i]["text"])])
    rows = []
    for i in sample:
        it = items[i]
        cond = design.condition_for(it)
        texts = design.prefixes(it["text"]) | {"full": it["text"]}
        jl = {k: labels.get((it["id"], cond, None if k == "full" else k)) for k in texts}
        if any(v is None or "percent" not in v for v in jl.values()):
            continue
        rows.append({"id": it["id"], "kind": it["kind"], "texts": texts, "judge": {k: v["percent"] for k, v in jl.items()},
                     "filter": {k: nb.estimate(nb.belief(feats_of(it, t), models[fold[i]])) for k, t in texts.items()}})
    stage_texts = [t for x in rows for t in x["texts"].values()]
    shares = iter(x["share"] for x in frontend.word_rules(stage_texts))
    for x in rows:
        x["rules"] = {k: next(shares) for k in x["texts"]}
    stages = ["1/3", "2/3", "full"]
    out = {"n": len(rows), "judge_mean": {s: r(np.mean([x["judge"][s] for x in rows])) for s in stages}}
    for who in ("filter", "rules"):
        out[who] = {"mae": {s: r(np.mean([abs(x[who][s] - x["judge"][s]) for x in rows])) for s in stages},
                    "label_agree": {s: r(np.mean([lab(x[who][s]) == lab(x["judge"][s]) for x in rows])) for s in stages}}
        dj = np.array([x["judge"]["full"] - x["judge"]["1/3"] for x in rows])
        dw = np.array([x[who]["full"] - x[who]["1/3"] for x in rows])
        moved = np.abs(dj) >= 0.1
        out[who]["delta_corr_1/3_to_full"] = r(np.corrcoef(dj, dw)[0, 1])
        out[who]["same_direction_when_judge_moves"] = r(np.mean(np.sign(dj[moved]) == np.sign(dw[moved]))) if moved.any() else None
        out["judge_moves_n"] = int(moved.sum())
    out["examples"] = [{"id": x["id"], "kind": x["kind"], "texts": x["texts"], **{w: {s: r(x[w][s], 2) for s in stages} for w in ("judge", "filter", "rules")}}
                       for x in sorted(rows, key=lambda x: -abs(x["judge"]["full"] - x["judge"]["1/3"]))[:6]]
    return out


WEIGHTS_ONLINE = [1, 3, 10]


def stream(base: nb.Model, seq: list[tuple[list[str], list[float]]], weight: float) -> list[float]:
    """Predict first, then learn: the absolute error of each item before the filter saw its label."""
    m = nb.Model(alpha=base.alpha, beta=base.beta, prior=list(base.prior), counts={f: list(c) for f, c in base.counts.items()}, totals=list(base.totals))
    errs = []
    for feats, dist in seq:
        target = sum(p * w for p, w in zip(dist, nb.LEVEL_WEIGHTS))
        errs.append(abs(nb.estimate(nb.belief(feats, m)) - target))
        if weight:
            nb.update(m, feats, dist, weight)
    return errs


def online(items, q, p) -> dict:
    """Half the items fit the filter; the other half arrive one by one. 5 random splits and orders."""
    curves = {w: [] for w in [0] + WEIGHTS_ONLINE}
    for seed in range(5):
        rng = random.Random(100 + seed)
        by_kind = defaultdict(list)
        for i, it in enumerate(items):
            by_kind[it["kind"]].append(i)
        a, b = [], []
        for k in sorted(by_kind):
            ix = by_kind[k][:]
            rng.shuffle(ix)
            a += ix[: len(ix) // 2]
            b += ix[len(ix) // 2:]
        rng.shuffle(b)
        base = nb.fit([feats_of(items[i]) for i in a], [list(q[i]) for i in a], p["alpha"], p["beta"], p["min_docs"], p["top_k"])
        seq = [(feats_of(items[i]), list(q[i])) for i in b]
        for w in curves:
            curves[w].append(stream(base, seq, w))
    n = min(len(c) for c in curves[0])
    blocks = [(s, min(s + 100, n)) for s in range(0, n, 100)]
    out = {"stream_items": n, "blocks": [f"{s + 1}-{e}" for s, e in blocks]}
    for w, runs in curves.items():
        mean = np.mean([run[:n] for run in runs], axis=0)
        out["static" if w == 0 else f"weight {w}"] = {"mae_all": r(mean.mean()), "mae_blocks": [r(mean[s:e].mean()) for s, e in blocks]}
    return out


def habit() -> dict:
    """A student with one unusual style: how fast does the filter (fit on all synthetic items) adapt?"""
    rows = read_jsonl(HABIT)
    labels = {x["id"]: x for x in read_jsonl(LABELS) if x["prefix"] is None and x["cond"] == "without"}
    kept = [h for h in rows if "probs" in labels[h["id"]]]
    seq_all = list(zip(featurize([(h["text"], False) for h in kept]), [labels[h["id"]]["probs"] for h in kept]))
    base = nb.load(WEIGHTS)
    pct = [sum(a * b for a, b in zip(d, nb.LEVEL_WEIGHTS)) for _, d in seq_all]
    curves = {w: [] for w in [0] + WEIGHTS_ONLINE}
    after = {w: {k: [] for k in (0, 5, 10, 20, 30)} for w in WEIGHTS_ONLINE}
    for seed in range(20):
        order = list(range(len(seq_all)))
        random.Random(200 + seed).shuffle(order)
        seq = [seq_all[i] for i in order]
        for w in curves:
            curves[w].append(stream(base, seq, w))
        for w in WEIGHTS_ONLINE:
            for k in after[w]:
                m = nb.Model(alpha=base.alpha, beta=base.beta, prior=list(base.prior), counts={f: list(c) for f, c in base.counts.items()}, totals=list(base.totals))
                for feats, dist in seq[:k]:
                    nb.update(m, feats, dist, w)
                rest = seq[k:]
                after[w][k].append(np.mean([abs(nb.estimate(nb.belief(f, m)) - sum(a * b for a, b in zip(d, nb.LEVEL_WEIGHTS))) for f, d in rest]))
    n = len(seq_all)
    blocks = [(s, min(s + 10, n)) for s in range(0, n, 10)]
    rules = frontend.word_rules([h["text"] for h in rows])
    out = {"n": n, "judge_mean": r(np.mean(pct)), "judge_labels": dict(Counter(lab(x) for x in pct)),
           "rules_mae": r(np.mean([abs(x["share"] - t) for x, t in zip(rules, pct)])), "blocks": [f"{s + 1}-{e}" for s, e in blocks]}
    for w, runs in curves.items():
        mean = np.mean(runs, axis=0)
        out["static" if w == 0 else f"weight {w}"] = {"mae_all": r(mean.mean()), "mae_blocks": [r(mean[s:e].mean()) for s, e in blocks]}
    out["mae_on_unseen_after_k_updates"] = {f"weight {w}": {str(k): r(np.mean(v)) for k, v in ks.items()} for w, ks in after.items()}
    return out


# Leon's numbers for his naive Bayes (frontend/eval/results/linter-2026-11-17.md at 058f289): trained
# leave-one-out on the same 136 prompts, so it cannot be rerun from here without his code.
LEON_BAYES = {"n": 136, "accuracy": 0.57, "kappa": 0.35, "weighted_kappa": 0.41, "source": "frontend/eval/results/linter-2026-11-17.md (058f289)"}


def leak_sensitivity(cases: list[dict]) -> dict:
    """Refit without the synthetic items that share most content words with one of Leon's prompts
    (common textbook topics, not copies; none is equal), then score his set again."""
    items, q = training_set()
    near = linter_set.near_matches([it["text"] for it in items], [c["text"] for c in cases])
    keep = [i for i in range(len(items)) if i not in near]
    p = shipped_params()
    fl = featurize([(items[i]["text"], nb.tutor_asked(items[i]["tutor"])) for i in keep])
    m = nb.rounded(nb.fit(fl, [list(q[i]) for i in keep], p["alpha"], p["beta"], p["min_docs"], p["top_k"]))
    pred = [lab(nb.estimate(nb.belief(f, m))) for f in featurize([(c["text"], False) for c in cases])]
    s = linter_set.summary([c["label"] for c in cases], pred, [c["tags"] for c in cases])
    return {"near_items_dropped": len(near), "examples": [items[i]["text"][:80] for i in sorted(near)[:5]],
            "accuracy": s["accuracy"], "kappa": s["kappa"], "weighted_kappa": s["weighted_kappa"]}


def linter_set_check(labels: dict) -> dict:
    """Leon's 136 prompts with his three draft labels: the word rules, his naive Bayes (quoted), this
    filter (trained on the synthetic set only) and the judge, in one table."""
    cases = linter_set.load()
    gold, tags, texts = [c["label"] for c in cases], [c["tags"] for c in cases], [c["text"] for c in cases]
    m = nb.load(WEIGHTS)
    feats = featurize([(t, False) for t in texts])
    est = [nb.estimate(nb.belief(f, m)) for f in feats]
    est1 = [nb.estimate(nb.belief(f, calibrated(m))) for f in feats]
    judge = [labels[(c["id"], "without", None)]["percent"] for c in cases]
    rule_out = frontend.word_rules(texts)
    rules = [x["mode"] for x in rule_out]
    combos = combinations([], est, rule_out, labels=gold)
    preds = {"rules": rules, "filter": [lab(e) for e in est], "filter calibrated": [lab(e) for e in est1],
             "mean of filter and draftShare": combos["mean"], "rules if linter >= 0.7 sure, else filter": combos["switch"],
             "judge": [lab(p) for p in judge]}
    prefetch_prefixes(texts)
    filt_words = [[lab(nb.estimate(nb.belief(feats_of({"text": t, "tutor": None}, t[:e]), m))) for e in design.chunk_ends(t)] for t in texts]
    return {
        "labels": "Claude's draft labels, not yet rated by the team",
        "judges": {k: linter_set.summary(gold, v, tags) for k, v in preds.items()} | {"naive Bayes (Leon, leave-one-out)": LEON_BAYES},
        "typing_flips": {"rules": flip_stats(rules_per_word(texts)), "filter": flip_stats(filt_words)},
        "share_rules_sure": combos["share_rules_sure"],
        "leak_sensitivity": leak_sensitivity(cases),
        "filter_vs_judge_percent_mae": r(np.mean(np.abs(np.array(est) - np.array(judge)))),
        "cases": [{"id": c["id"], "text": c["text"], "label": c["label"], "tags": c["tags"], "rules": rules[i],
                   "filter": r(est[i]), "judge": r(judge[i])} for i, c in enumerate(cases)],
    }


def main() -> None:
    items_all = read_jsonl(SYNTHETIC)
    labels = {(x["id"], x["cond"], x["prefix"]): x for x in read_jsonl(LABELS)}
    res = {"history": history(items_all, labels), "judge": judge_overview(items_all, labels), "sonnet": sonnet_check(items_all, labels)}
    items, q = training_set()
    p = shipped_params()
    fold, models = fold_models(items, q, p)
    res["params"] = p
    res["filter"], _ = filter_eval(items, q, fold, models)
    res["word_by_word"] = word_by_word(items, fold, models)
    res["prefixes"] = prefixes_check(items, labels, fold, models)
    res["online"] = online(items, q, p)
    res["habit"] = habit()
    res["linter_set"] = linter_set_check(labels)
    write_json(RESULTS, res)
    print(json.dumps({k: res[k] for k in ("params",)}), file=sys.stderr)
    f = res["filter"]
    for key in ("filter", "rules_share", "rules_linter_label", "prior"):
        print(f"{key:20s} mae {f[key].get('mae', '-')!s:6s} agree {f[key]['agree']} kappa {f[key]['kappa']}", file=sys.stderr)
    print(f"wrote {RESULTS}", file=sys.stderr)


if __name__ == "__main__":
    main()
