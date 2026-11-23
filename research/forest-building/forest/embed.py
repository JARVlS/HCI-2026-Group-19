"""Text embeddings (pluggable backend, cached) and the topic shortlist.

Every vector is L2-normalised, so a dot product is the cosine. Sentence-transformers models are
loaded only on a cache miss, so a run from data/frozen/ needs neither torch nor a download.
"""
from __future__ import annotations

import base64
import re
from functools import lru_cache
from typing import Literal

import numpy as np

from . import cache
from .model import Forest

TopicVector = Literal["centroid", "label", "mix"]


def _encode(v: np.ndarray) -> str:
    return base64.b64encode(v.astype(np.float32).tobytes()).decode()


def _decode(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=np.float32)


@lru_cache(maxsize=4)
def _st_model(name: str):
    import logging
    import os
    import warnings
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    logging.getLogger("torch.distributed.elastic.multiprocessing.redirects").setLevel(logging.ERROR)
    warnings.filterwarnings("ignore", module="tqdm")
    from sentence_transformers import SentenceTransformer  # heavy; only on a cache miss
    return SentenceTransformer(name)


class Embedder:
    """embed(texts) -> (n, dim) array of unit vectors, cached per (model, text)."""

    def __init__(self, cfg: dict, backend: str | None = None):
        self.name = backend or cfg["embed"]["backend"]
        spec = cfg["embed"]["backends"][self.name]
        self.kind = spec["kind"]
        self.model = spec.get("model", self.name)
        self._mem: dict[str, np.ndarray] = {}
        self._tfidf = None

    def embed(self, texts: list[str]) -> np.ndarray:
        if self.kind == "tfidf":
            return self._embed_tfidf(texts)
        store = cache.store("embeddings")
        out: list[np.ndarray | None] = []
        missing: list[str] = []
        for t in texts:
            if t in self._mem:
                out.append(self._mem[t])
                continue
            hit = store.get(cache.key("embed", self.model, t))
            if hit is not None:
                v = _decode(hit)
                self._mem[t] = v
                out.append(v)
            else:
                out.append(None)
                missing.append(t)
        if missing:
            uniq = list(dict.fromkeys(missing))
            if cache.REQUIRE_CACHED:
                raise cache.CacheMiss(f"{len(uniq)} texts not in the embedding cache, e.g. {uniq[0]!r}")
            vecs = _st_model(self.model).encode(uniq, normalize_embeddings=True, batch_size=64, show_progress_bar=False)
            for t, v in zip(uniq, vecs):
                v = np.asarray(v, dtype=np.float32)
                self._mem[t] = v
                store.put(cache.key("embed", self.model, t), _encode(v), model=self.model, text=t)
            out = [self._mem[t] if o is None else o for t, o in zip(texts, out)]
        return np.vstack(out) if out else np.zeros((0, 1), dtype=np.float32)

    def one(self, text: str) -> np.ndarray:
        return self.embed([text])[0]

    def _embed_tfidf(self, texts: list[str]) -> np.ndarray:
        if self._tfidf is None:
            from sklearn.feature_extraction.text import TfidfVectorizer

            from .io import load_sessions
            corpus = [p.text for s in load_sessions().values() for p in s.prompts]
            self._tfidf = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, stop_words="english").fit(corpus)
        m = self._tfidf.transform(texts).toarray().astype(np.float32)
        n = np.linalg.norm(m, axis=1, keepdims=True)
        n[n == 0] = 1
        return m / n


# --- topic similarity ---------------------------------------------------------------------------

def calibrate(cos: float | np.ndarray, lo: float, hi: float):
    """Raw cosine -> [0, 1]: lo maps to 0, hi to 1, clipped (the scale of the judge's rescaled fits)."""
    return np.clip((np.asarray(cos) - lo) / (hi - lo), 0.0, 1.0)


def cal_bounds(cfg: dict, backend: str) -> tuple[float, float]:
    c = cfg["scores"]["calibration"][backend]
    return float(c["lo"]), float(c["hi"])


def fit_calibration(emb: "Embedder", sessions: dict, golds: dict) -> dict[str, float]:
    """lo = median cosine of a prompt to the gold topic labels of the other sessions (unrelated);
    hi = 75th percentile of a prompt's cosine to its own gold topic label."""
    own, other = [], []
    labels = {sid: sorted({g.topic for g in gold.values()}) for sid, gold in golds.items()}
    for sid, s in sessions.items():
        V = emb.embed([p.text for p in s.prompts])
        for i, p in enumerate(s.prompts):
            own.append(float(V[i] @ emb.one(golds[sid][p.id].topic)))
            for sid2, labs in labels.items():
                if sid2 != sid:
                    other.extend((emb.embed(labs) @ V[i]).tolist())
    return {"lo": round(float(np.median(other)), 3), "hi": round(float(np.percentile(own, 75)), 3)}


def prompt_topic_cosine(emb: Embedder, forest: Forest, text: str, topic_id: str, option: TopicVector,
                        exclude: str | None = None, label: str | None = None) -> float:
    """Cosine of a prompt to a topic. centroid: mean of the topic's prompts (without `exclude`);
    label: the topic's label; mix: the mean of the two. A topic without prompts uses its label."""
    v = emb.one(text)
    lab = label if label is not None else forest.topics[topic_id].label
    c_label = float(v @ emb.one(lab))
    if option == "label":
        return c_label
    members = [p for p in forest.prompts_in(topic_id) if p != exclude] if topic_id in forest.topics else []
    if not members:
        return c_label
    cen = emb.embed([forest.prompts[p].text for p in members]).mean(axis=0)
    cen = cen / (np.linalg.norm(cen) or 1)
    c_cen = float(v @ cen)
    return c_cen if option == "centroid" else 0.5 * (c_cen + c_label)


def shortlist(emb: Embedder, forest: Forest, text: str, k: int, option: TopicVector = "mix",
              include_parents: bool = True, enabled: bool = True) -> list[str]:
    """The k topics most similar to the prompt (all topics when disabled), plus their parents."""
    if not enabled or len(forest.topics) <= k:
        return sorted(forest.topics)
    scored = sorted(forest.topics, key=lambda c: -prompt_topic_cosine(emb, forest, text, c, option))
    top = scored[:k]
    if include_parents:
        for c in list(top):
            t = forest.topics[c]
            if t.parent_kind == "topic" and t.parent_id not in top:
                top.append(t.parent_id)
    return top


# --- key phrases (used by the offline judge to name candidate topics) ---------------------------

STOP = set("""a an the and or but if then else of to in on for with without at by from as is are was were be been
being do does did doing i me my we our you your it its this that these those there here what which who whom whose
why how when where can could should would will shall may might must not no yes so than too very just about into
over under again further once all any both each few more most other some such only own same also
get got really actually like still even ever please thanks thank exactly does doesn't don't isn't i'm
i've it's what's that's can't let's whats im sure need want use used using understand mean means meant think
know make makes made give tell explain help someone something anything way ways people one ones first
compute computes computed computing doing goes going go happen happens happening matter matters pick say says
seem seems keep kept tried try trying wrote write derived look looks stuck confused confusing confuse mix
wrong right good bad enough small big practice completely intuitively super else always never every
exercise sheet lecture homework quiz question questions example simple separate whole hand lot part thing
things stuff step steps work works check fine instead difference different between ok okay supposed
come comes came where's why's them they their he she his her us one's""".split())
CONNECTORS = {"of", "and", "vs", "in", "for", "to"}

_WORD = re.compile(r"[A-Za-z][A-Za-z0-9'\-^]*")


def candidate_phrases(text: str, max_len: int = 3) -> list[str]:
    """Contiguous 1..max_len word n-grams without stop words at either end, lowercased, unique."""
    words = [w.lower().strip("'") for w in _WORD.findall(text)]
    out = []
    for n in range(1, max_len + 1):
        for i in range(len(words) - n + 1):
            g = words[i:i + n]
            if g[0] in STOP or g[-1] in STOP or len(g[0]) < 3 or len(g[-1]) < 3:
                continue
            if any(w in STOP and w not in CONNECTORS for w in g) or any(len(w) < 2 for w in g):
                continue
            out.append(" ".join(g))
    return list(dict.fromkeys(out))


def keyphrases(emb: Embedder, texts: list[str], k: int = 2, diversity: float = 0.5) -> list[str]:
    """KeyBERT-style: phrases from `texts` closest to their centroid, with maximal marginal relevance."""
    cands = list(dict.fromkeys(c for t in texts for c in candidate_phrases(t)))
    if not cands:
        return []
    doc = emb.embed(texts).mean(axis=0)
    doc = doc / (np.linalg.norm(doc) or 1)
    cv = emb.embed(cands)
    rel = cv @ doc
    # prefer 2-word phrases slightly: single words are often too broad, 3-grams too specific
    rel = rel + np.array([0.02 if len(c.split()) == 2 else 0.0 for c in cands])
    chosen: list[int] = []
    for _ in range(min(k, len(cands))):
        if not chosen:
            chosen.append(int(np.argmax(rel)))
            continue
        red = (cv @ cv[chosen].T).max(axis=1)
        mmr = (1 - diversity) * rel - diversity * red
        mmr[chosen] = -np.inf
        chosen.append(int(np.argmax(mmr)))
    return [titlecase(cands[i]) for i in chosen]


def titlecase(phrase: str) -> str:
    small = {"and", "of", "vs", "in", "on", "the", "a", "to", "for"}
    words = phrase.split()
    return " ".join(w if (i and w in small) else (w[0].upper() + w[1:]) for i, w in enumerate(words))
