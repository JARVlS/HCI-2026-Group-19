# Designing a Topic Forest for Fast Retrieval of Past Questions

*HCI 2026 – Group 19 – Milestone 3: UI Optimization. DRAFT for the group to edit; all numbers come from `ui_optimization.ipynb` (section numbers in brackets). Text limit of the final PDF: 3.5 pages without figures.*

---

## 1. Overview of the task (≈ 0.5 page)

**What we optimize.** Our prototype sorts the prompts a student sends to an AI tutor into a **knowledge forest**: groups (one per subject) hold trees of topics, and every prompt sits in one topic. After every prompt the system must decide what happens to the forest:

| | outcome | meaning |
|---|---|---|
| (a) | add | the prompt goes into an existing topic |
| (b) | new branch | a new topic under an existing topic |
| (c) | new tree | a new topic directly under an existing group |
| (d) | new group | a new group (subject) with a new tree |
| (e) | restructure | older prompts move; a topic left empty is deleted |

**Why it needs optimization.** The forest exists so that the student finds earlier questions again, quickly. That is a trade-off: many small topics mean more levels to click through, few large topics mean long lists to read, a question filed where the student does not expect it is found only by searching the whole history, and every restructure disturbs a structure the student has already learned. Simple rules serve one side only: always opening the best-fitting new topic never repairs old questions that are left in the wrong place, and never opening one produces long, mixed lists.

**Approach.** The objective is the **time the student spends**, in seconds, predicted by a user model of the tree view (Hick–Hyman choice per level, linear reading inside a topic, search of the history for misfiled questions) plus the one-time costs of changes. Each step is a small mixed-integer linear program solved with Gurobi:

```
new prompt + current forest -> [LLM judge] -> proposal and scores -> [IP, Gurobi] -> new forest + outcome
```

The LLM judge (Claude Haiku 5.5) proposes at most one new topic and rates how well prompts fit topics; the IP decides. We run this over a scripted study session: a starting forest with *Neural networks* (two questions) and *Gradient descent*, which has grown long (four questions, two about the learning rate), followed by 11 questions chosen so that every outcome can occur (8 on deep learning, 3 on linear algebra in between).

**Result in one sentence.** The IP splits the overloaded topic as soon as a fitting subtopic is proposed (it creates *Learning rate* and moves the two learning-rate questions into it) and otherwise opens proposed topics when the parent is long enough; its forest needs 5.0 s per lookup instead of 6.0 s for the greedy rule (−17 %), 878 s instead of 1033 s in total, and agrees best with a hand-made grouping (pairwise F1 0.84 vs. 0.57).

---

## 2. Definition of variables and constraints (≈ 1 page)

**Structure in words.** At every step the forest before the step is fixed. The new prompt must be placed in an existing topic or in one of the *open proposals* (topics the LLM proposed for this or an earlier prompt that have not been created). Old prompts may stay or move; a topic left without prompts and subtopics is deleted; at most one new topic, possibly with its new group, is created.

**Session** (§1, `session.py`). Start: group *Deep learning* with *Neural networks* ($p_0$, $p_1$) and *Gradient descent* ($p_2,\dots,p_5$; $p_3$, $p_4$ are about the learning rate). Then $n_1,\dots,n_{11}$ arrive in order.

**Inputs from the LLM** (§2, §5a). For every new prompt, one call to Claude Haiku 5.5 (`claude-haiku-5-5`) in a fresh session that sees only the current forest and the new prompt:
1. *propose* at most one new topic with its parent (an existing topic → (b), an existing group → (c), or a new group → (d)), only if the prompt fits it perfectly and every listed topic at most 4 of 5;
2. *judge* the new prompt against every topic and open proposal, and every earlier prompt against the new proposal, on a 1–5 rubric (5 = squarely about this topic, 4 = belongs to a more specific subtopic that is not listed, … 1 = unrelated).

The score $j_{pc}$ is rescaled to the fit $s_{pc} = (j_{pc}-1)/4 \in \{0, 0.25, 0.5, 0.75, 1\}$. Each score is asked once, when both the prompt and the topic exist, so later prompts never influence earlier scores.

**Sets** (per step). $G^{old}$ / $G^{new}$: existing groups / groups an open proposal would create. $C^{old}$ / $C^{new}$: existing topics / open proposals, $C = C^{old}\cup C^{new}$. $\pi(c)$: parent of $c$ (fixed; chosen by the LLM for proposals); $K(c)$: subtopics of $c$. $V$: choice points of the tree view (the root $r$, every group, every topic that can have subtopics), $O(v)$ the options $v$ can offer, $B(v)$ the topics below $v$. $P^{old}$: prompts in the forest, $p$ in topic $c^0(p)$; $n$: the new prompt; $P = P^{old}\cup\{n\}$, $N = |P|$.

**Decision variables.**

| variable | meaning |
|---|---|
| $q_{pc}\in\{0,1\}$ | prompt $p$ is in topic $c$ after the step |
| $y_c\in\{0,1\}$ | topic $c$ exists after the step (old: kept / deleted; proposal: created) |
| $g_G\in\{0,1\}$ | new group $G$ is created |
| $z\in\{0,1\}$ | the step is a restructure (an old prompt moves) |
| $e_{vk}\in\{0,1\}$, $\omega_{vk}\ge 0$ | choice point $v$ offers $k$ options; prompts passing through $v$ if so, else 0 |
| $\delta_{ck}\in[0,1]$, $k=1..N$ | the $k$-th prompt of topic $c$ (filled from $k=1$ upwards) |
| $u_p\in[0,1]$ | prompt $p$ is misfiled |

**Constraints.**

$$
\begin{aligned}
&\textstyle\sum_{c} q_{pc} = 1,\quad q_{pc} \le y_c && \text{(1, 2) each prompt in one existing topic}\\
&\textstyle y_c \le \sum_p q_{pc} + \sum_{k\in K(c)} y_k && \text{(3) no empty topics (emptied old topics are deleted)}\\
&y_c \le y_{\pi(c)};\quad y_c \le g_{\pi(c)} \text{ if } \pi(c)\in G^{new} && \text{(4, 5) a branch needs its parent; a tree in a new group needs the group}\\
&\textstyle\sum_k e_{vk} = 1,\; \sum_k k\,e_{vk} = n_v;\quad \omega_{vk} \ge \sum_p\sum_{c\in B(v)} q_{pc} - N(1-e_{vk}) && \text{(6, 7) options at } v \text{, prompts through } v\\
&\textstyle\sum_p q_{pc} = \sum_{k=1}^{N} \delta_{ck} && \text{(8) size of } c\\
&\textstyle u_p \ge \sum_c m_{pc}q_{pc},\quad u_p \ge y_k - \sum_{c:\,s_{pc}\ge s_{pk}} q_{pc} && \text{(9) misfiled}\\
&\textstyle \sum_{c\ne c^0(p):\,s_{pc}<s_{pk}} q_{pc} + y_k \le 1 && \text{(10) file by meaning}\\
&z \ge 1 - q_{p,c^0(p)} && \text{(11) a move is a restructure}\\
&\textstyle\sum_{c\in C^{new}} y_c \le 1 && \text{(12) slow growth}
\end{aligned}
$$

with $n_r = |G^{old}| + \sum_G g_G$ and $n_v = \sum_{c\in O(v)} y_c$. **Linearization.** The navigation time multiplies the choice time $\log_2(n_v+1)$, not linear in $n_v$, with the number of prompts passing through $v$: (6) selects the count with $e_{vk}$ and the big-M constraint (7) gives $\omega_{vk}$ that number when the count is $k$. The reading time $R\,|c|(|c|+1)/2$ is convex in the size: (8) splits the size into increments $\delta_{ck}$ that cost $R\,k$, which the minimum fills from $k = 1$ upwards, so the sum is exact without binaries. (9) makes a prompt misfiled if a topic that fits it better exists, otherwise with probability $m_{pc}$: 0 for scores 4 and 5 (a 4 means the prompt belongs to a subtopic that does not exist yet, so its topic is still where the student looks), $1-s_{pc}$ for lower scores. (10) is a design rule: the system never places or moves a prompt into a topic that fits worse than another existing one; old prompts can still become misfiled passively when a better topic is created and they are not moved. A deletion needs no constraint of its own (it implies moves, hence $z$), and a new group without a tree only costs, so it is never chosen.

**Outcome.** With $c^*$ the topic of the new prompt: $c^*$ old → (a); new with a topic as parent → (b); new under an old group → (c); new under a new group → (d); $z = 1$ → (e). The largest step has 362 variables and 483 constraints, within the free pip license (2000 each).

---

## 3. Definition of the objective function (≈ 1 page)

**User model** (§4a). One lookup of prompt $p$ in topic $c$: the student chooses a group, a tree and a branch at every level, then reads the questions of $c$ one by one:

$$
T_p = \sum_{v\in A(c)}\big(a + b\log_2(n_v+1)\big) \;+\; R\,\frac{|c|+1}{2} \;+\; u_p\,R\,\frac{N+1}{2}
$$

**Where it comes from.** Cockburn, Gutwin & Greenberg (2007) predict the time to select a menu item as a search/decision time plus a pointing time (Fitts' law); the search time moves with practice from a linear visual search (novice) to a Hick–Hyman decision, logarithmic in the number of items (expert) [Hick 1952; Hyman 1953]. We adopt this idea for the tree view: topic labels are short and known, so choosing among the $n_v$ options at a choice point $v\in A(c)$ uses the Hick–Hyman form; questions are long texts without a label, so they are scanned linearly, on average $(|c|+1)/2$; pointing and clicking per level is a constant $a$ (KLM), and the levels add up as in a cascading menu. A misfiled question is found by scanning the whole history. This is the breadth/depth trade-off of hierarchical menus [Miller 1981; Kiger 1984]. Summed over the questions, $T_p$ gives the expected selection time $T=\sum_i p_i t_i$ of the lecture's menu example; we use it both as the **objective** and to **evaluate** all designs.

**Objective** (minimize, seconds):

$$
\min\; H\sum_p T_p \;+\; \lambda\sum_{c\in C^{new}} y_c + \lambda_G\sum_G g_G \;+\; \sum_{p\in P^{old}} \mu_p \big(1-q_{p,c^0(p)}\big) + F z
$$

written with the linearization variables of Section 2 (navigation $N\sum_k (a+b\log_2(k+1))e_{rk} + \sum_{v\ne r}\sum_k (a+b\log_2(k+1))\,\omega_{vk}$, reading $\sum_{c,k} R\,k\,\delta_{ck}$, misfiled $R\frac{N+1}{2}\sum_p u_p$). The first term is the lasting cost: every question looked up $H$ times. The others are paid once: a new label is read once, a moved question is first looked for in its old place ($\mu_p$ = one failed lookup: navigate to its old topic and read all of it, computed from the forest before the step), and any restructure needs a look over the changed tree ($F$).

**Parameters** (§3).

| | value | justification |
|---|---|---|
| $a$ | 1.1 s | open one level: point and click (KLM pointing $P$ [Card et al. 1980]) |
| $b$ | 0.15 s/bit | Hick–Hyman slope, about 150 ms/bit [Card et al. 1983] |
| $R$ | 1.0 s | read one question (≈ 8 words) while skimming for a known one |
| $\lambda$, $\lambda_G$ | 1.0 s | read a new label once ($= R$) |
| $\mu_p$ | derived | one failed lookup in the old place (≈ 6.6 s for a question in *Gradient descent* at the start) |
| $H$ | 10 | future lookups of every question (assumption; varied 1–40) |
| $F$ | 5 s | re-orientation after any restructure (assumption; varied 0–40) |

$a$, $b$ and $R$ come from standard models; $H$ and $F$ are our assumptions, and the what-if analysis shows which decisions depend on them. Two prompts with identical scores cost the same to move; a tie-breaker of 0.001 s per later question moves the more recent one. Gurobi solves every step to proven optimality (MIPGap 0).

**Why this is not a simple rule.** The greedy rule "every prompt into its best-fitting topic" ignores old prompts and the length of topics. The reading term rewards splitting a long topic, even by moving old prompts; navigation and new labels penalize many small topics; the disruption terms penalize moving.

**Worked example: step 1, "What does the learning rate do?"** (§6; $H\cdot$lookups + one-time costs):
- add it to *Gradient descent* (score 4, so not misfiled): 361.1 s, but the topic grows to five questions;
- open *Learning rate* for it alone, as the greedy rule does: 414.6 s; $p_3$ and $p_4$, rated 5 for *Learning rate* and 4 for *Gradient descent*, are now misfiled (misfiled term 80 s);
- open *Learning rate* and move $p_4$: 378.7 s; move $p_3$ and $p_4$ (**IP**): 357.8 s, although the two moves and the restructure cost 18.2 s once. Outcome (e), margin 3.3 s to the runner-up (adding $n_1$ to *Gradient descent*).

**Model citation.** Proposals and scores: Claude Haiku 5.5 (`claude-haiku-5-5`, Anthropic), one fresh conversation per question via the Claude Code CLI, 27 Nov 2026. Prompts and raw answers are in `llm_steps/`; the notebook replays these frozen answers, so it runs without any LLM call.

---

## 4. Analysis of the resulting designs (≈ 1 page)

**The optimal design** (§5b, §6). Outcomes over the 11 steps: `e b d b a a a b a c b`.

> **[Figure 1]** `show_session(ip_history)`: the forest after every step (§6).
> **[Figure 2]** `show_step(ip_history, k=1)`: step 1 before/after, the split of *Gradient descent*.

At step 1 the IP splits the overloaded *Gradient descent*. It opens a topic for a single new question when the parent is long enough that the shorter list saves more reading than the extra level costs (*Activation functions*, *Backpropagation*, *Optimizers*, *Regularization*), and later questions of these themes are added to them (a). A new subject gets its own group immediately (step 3; the best existing topic would cost 48.5 s more), and SVD becomes a second tree in it (step 10). For every step we also solved for the second-best decision (excluding the optimum with a no-good cut $\sum_p q_{p,a(p)} \le |P|-1$): the topics for single questions are close calls (margins 2.5–6.5 s against filing the question in the parent), the other decisions are clear (15–33 s).

**Alternative designs** (§7), on the same session and LLM answers:
- **H0 – chronological**: blocks of three prompts in arrival order, as in today's chat sidebars; its labels are blocks of time, so the student cannot choose by meaning (every lookup ends in scanning the history);
- **H1 – best existing topic**: never creates a topic;
- **H2 – greedy best match**: always takes the highest-scoring option, including proposals ("best option everywhere"), never moves.

Besides the user model we measure agreement with a **hand-made ideal forest** (written before the LLM answers were collected, never shown to the LLM or solver) by pairwise F1 over "these two prompts share a topic / a tree". It is independent of the LLM's scores and of our user model.

| | lookup (s) | total (s) | one-time (s) | F1 topic | F1 tree | topics | one-prompt topics | moves |
|---|---|---|---|---|---|---|---|---|
| H0 chronological | 13.7 | 2342 | 5 | 0.30 | 0.39 | 6 | 0 | 0 |
| H1 best existing | 9.5 | 1607 | 0 | 0.26 | 0.61 | 2 | 0 | 0 |
| H2 greedy | 6.0 | 1033 | 8 | 0.57 | **0.81** | 9 | 3 | 0 |
| **IP** | **5.0** | **878** | 26 | **0.84** | **0.81** | 9 | 2 | 2 |

*lookup*: mean time of one lookup in the final forest; *total*: $H$ lookups of every question plus the one-time costs of the session.

> **[Figure 3]** `show_final_trees(HISTORIES)`: the four final forests side by side (§7).

H0 is slowest because time blocks carry no meaning. H1 piles everything into two topics of 10 and 7 questions and files linear algebra under *Neural networks*: long lists and misfiled questions. H2 and the IP end with the same topics; they differ in one decision. H2 puts only the new question into *Learning rate* and leaves $p_3$, $p_4$ misfiled in a long *Gradient descent*; the IP moves them. This costs 18 s more once and saves about 1 s on every lookup, and it also gives the best agreement with the ideal forest, which the IP never saw. The IP thus differs from "best option everywhere" exactly where a rule that only looks at the new prompt cannot help.

**What-if** (§8; the whole session re-solved with the stored LLM answers).

| change | effect |
|---|---|
| $H \ge 10$, $F \le 5$ s | as in the default run |
| $H \le 5$ or $F \ge 10$ s | the one-time costs of the split do not pay off: $n_1$ stays in *Gradient descent* |
| $H \le 2$ | fewer topics: with $H = 2$, $n_{11}$ stays in *Neural networks*; with $H = 1$, $n_2$ and later $n_6$ stay there too (no *Activation functions*) |
| $R = 0.75$ s | *Backpropagation* waits for the second question, then is created and $n_4$ moves in |
| $a = 2$ s | *Activation functions* waits for the second question, then is created and $n_2$ moves in |

In every run the IP's total time is below that of the greedy rule H2.

**Critical examination** (§9).
- *Inputs.* One run of one model, not compared with human ratings; the CLI has no temperature setting, so reproducibility relies on the frozen answers. The baselines and what-if runs reuse answers collected along the IP's own path (no unrated pair was needed, but on other paths the LLM might have proposed other topics). The LLM's topics and scores are taken as they are: e.g. $p_0$ ("What does an activation function do?") stays in *Neural networks*, because the LLM rates it 5 there and 5 for *Activation functions*.
- *User model.* $a$, $b$, $R$ are literature values, not fitted to our tree view; $H$ and $F$ are assumptions. Labels are assumed to be recognised perfectly, a misfiled question costs a scan of the whole history wherever it is, and visual clutter is not modelled, so topics for single questions are close calls. Topics are never moved, renamed or merged; at most one new topic per step; decisions are myopic.
- *Evaluation.* One short scripted session written by us, with an overloaded starting topic and questions chosen so that every outcome occurs; we reworded two starting questions after a first run in which the LLM rated them 5 for *Gradient descent* as well as for *Learning rate*. The ideal forest is one reasonable grouping (10 "together" pairs). Lookup time comes from the model the IP optimizes; only F1 is independent. Whether students really find their questions faster is tested in Milestone 4, whose logged lookup times could also be used to fit $a$, $b$, $R$ and $H$.

**Use in the prototype.** The IP's forest after every step is exported to `export/ip_forest_sequence.json` (§10) and is condition B of the Milestone 4 A/B test; condition A is the chronological list (H0) or the greedy rule (H2).

**References.** Anthropic (2026), Claude Haiku 5.5, accessed 27 Nov 2026. — Card, Moran & Newell (1980), The keystroke-level model for user performance time with interactive systems, *CACM* 23(7). — Card, Moran & Newell (1983), *The Psychology of Human-Computer Interaction*. — Cockburn, Gutwin & Greenberg (2007), A predictive model of menu performance, *CHI '07*. — Hick (1952), On the rate of gain of information, *QJEP* 4(1). — Hyman (1953), Stimulus information as a determinant of reaction time, *J. Exp. Psychol.* 45(3). — Kiger (1984), The depth/breadth trade-off in the design of menu-driven user interfaces, *IJMMS* 20(2). — Miller (1981), The depth/breadth tradeoff in hierarchical computer menus, *Proc. HFS* 25(1).

---

### Still to do for the submission
- [ ] Shorten to ≤ 3.5 pages of text; paste Figures 1–3 from the notebook.
- [ ] Group review of the starting forest and the ideal forest in `session.py` (`INITIAL_PROMPTS`, `IDEAL`).
- [ ] Update the Milestone 4 prototype to the new starting forest (*Neural networks*, *Gradient descent*, six prompts) and `export/ip_forest_sequence.json`.
- [ ] Blog post with links to the optimization task, the resulting designs and this analysis.
- [ ] Copy `ui_optimization.ipynb` and `requirements.txt` (and the PDF) to `Deliverables/UIOptimization/` of the group repository; also copy `session.py`, `judge.py`, `forest.py`, `visualization.py` and `llm_steps/`, so the notebook runs from the zip without downloading this repository.
