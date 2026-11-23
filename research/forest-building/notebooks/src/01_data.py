# %% [markdown]
# # 01 Data: sessions, gold labels and the forest model
#
# **Question.** Do the three scripted sessions load, does a hand-built forest validate, and do
# invalid forests (a cycle, an empty topic) fail with a clear message?
#
# **Status of the data.** The prompts and the gold labels are **drafts** written by Claude Opus 5.5
# (`claude-opus-5-5`) on 23 Nov 2026 (`scripts/draft_sessions.py`). The group must review the
# prompts for realism and fill in `data/gold/*_template.csv` before any number computed against the
# gold labels is reported. Every gold-based number in these notebooks is a draft number.

# %%
import sys
from pathlib import Path

ROOT = Path.cwd().parent if Path.cwd().name == "notebooks" else Path.cwd()
sys.path.insert(0, str(ROOT))

import pandas as pd

from forest.io import SESSION_IDS, gold_forest, load_gold, load_sessions
from forest.model import Forest, ForestError, Group, Prompt, Topic

pd.set_option("display.max_colwidth", 120)
sessions = load_sessions()
golds = {sid: load_gold(sid) for sid in SESSION_IDS}

# %% [markdown]
# ## The sessions
# Each prompt has an id, a text, a step and a chat. `access_events` say which earlier prompt the
# student re-opened at which step; they make recently used prompts expensive to move (`w[p]`, plan §5.4).

# %%
rows = []
for sid, s in sessions.items():
    g = golds[sid]
    rows.append({"session": sid, "prompts": len(s.prompts), "chats": len({p.chat_id for p in s.prompts}),
                 "access events": len(s.access_events), "gold groups": len({x.group for x in g.values()}),
                 "gold trees": len({" > ".join(x.parts[:2]) for x in g.values()}),
                 "gold topics": len({x.path for x in g.values()}), "draft": s.draft, "purpose": s.description})
pd.DataFrame(rows)

# %%
s1 = sessions["s1_focused"]
pd.DataFrame([{"step": p.step, "chat": p.chat_id, "text": p.text, "gold path": golds["s1_focused"][p.id].path}
              for p in s1.prompts]).head(12)

# %% [markdown]
# ## The gold forests
# The forest the draft labels describe after the last prompt, as an outline (`(n)` = prompts attached).

# %%
for sid, s in sessions.items():
    f = gold_forest(s, golds[sid], len(s.prompts) + 1).validate(D=3)
    print(f"--- {sid}")
    print(f.render())

# %% [markdown]
# ## A hand-built forest validates and survives a JSON round trip

# %%
f = Forest(step=3)
f.groups["g1"] = Group("g1", "Deep Learning")
f.topics["t1"] = Topic("t1", "Backpropagation", "g1", "group")
f.topics["t2"] = Topic("t2", "Vanishing gradients", "t1", "topic")
for i, t in [(1, "t1"), (2, "t1"), (3, "t2")]:
    f.prompts[f"p{i}"] = Prompt(f"p{i}", f"prompt {i}", i, "demo")
    f.assignment[f"p{i}"] = t
    f.access_log[f"p{i}"] = i
f.validate(D=3)
assert Forest.from_json(f.to_json()).to_json() == f.to_json()
print(f.render())
print("valid; JSON round trip identical")

# %% [markdown]
# ## Invalid forests fail with a clear message

# %%
def show(label, forest, D=3):
    try:
        forest.validate(D)
        print(f"{label}: valid (unexpected)")
    except ForestError as e:
        print(f"{label}:\n  " + "\n  ".join(e.problems))

cyc = f.copy()
cyc.topics["t1"] = Topic("t1", "Backpropagation", "t2", "topic")
show("cycle", cyc)

empty = f.copy()
empty.topics["t3"] = Topic("t3", "Optimizers", "g1", "group")
empty.groups["g2"] = Group("g2", "Linear Algebra")
show("empty topic and group", empty)

show("depth limit D=1", f, D=1)

# %% [markdown]
# ## Findings
#
# - All three sessions load: 30, 30 and 25 prompts in 2 chats each, with 4 to 5 access events.
#   The draft gold labels give 1 to 3 groups and 9 to 12 topics per session (table above).
# - The gold forests validate with `D = 3`. `s1_focused` puts 18 of 30 prompts into the
#   Backpropagation tree, so a topic limit of `U = 6` forces splits there, as intended.
# - A hand-built forest validates, and its JSON round trip is identical. The same JSON is the
#   per-step snapshot format in `outputs/forests/`.
# - A cycle, an empty topic, an empty group and a too-deep topic each fail with a message that
#   names the topic or group.
# - *For the group:* review the prompts for realism, then fill in the gold templates.
