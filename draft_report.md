# Designing a Topic Forest for Findable and Stable Learning History

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

**Why it needs optimization.** Three goals conflict. *Semantic fit*: a prompt should be where the student would look for it. *A tidy structure*: topics should be neither overloaded nor near-empty, and the forest should not sprout a topic for every prompt. *Stability*: moving prompts the student has already seen breaks their mental map. A simple rule serves one goal at the expense of the others.

**Approach.** Each step is a small integer program (IP) solved with Gurobi:

```
new prompt + current forest -> [LLM judge] -> proposal and scores -> [IP, Gurobi] -> new forest + outcome
```

The LLM judge (Claude Haiku 5.5) proposes at most one new topic and rates how well prompts fit topics; the IP decides. We run this over a scripted study session of 11 questions (8 on deep learning, 3 on linear algebra in between) and obtain the sequence of forests the student would see.

**Result in one sentence.** The IP opens a topic only when a second question on its theme arrives (then moves the first one in), opens a new group as soon as a question of a new subject arrives, and reaches almost the agreement with a hand-made grouping of the greedy rule (pairwise F1 0.57 vs 0.62) with half as many one-question topics (2 vs 4), at the price of 3 moves.

---

## 2. Definition of variables and constraints (≈ 1 page)

**Structure in words.** At every step the forest before the step is fixed. The new prompt must be placed in an existing topic or in one of the *open proposals* (topics the LLM proposed for this or an earlier prompt that have not been created). Old prompts may stay or move; a topic left without prompts and subtopics is deleted; at most one new topic, possibly with its new group, is created.

**Session** (§1, `session.py`). Start: group *Deep learning* with *Deep learning basics* ($p_0$) and *Gradient descent* ($p_1$). Then $n_1,\dots,n_{11}$ arrive in order.

**Inputs from the LLM** (§2, §5a). For every new prompt, one call to Claude Haiku 5.5 (`claude-haiku-5-5`) in a fresh session that sees only the current forest and the new prompt:
1. *propose* at most one new topic with its parent (an existing topic → (b), an existing group → (c), or a new group → (d)), only if the prompt fits it perfectly and every listed topic at most 4 of 5;
2. *judge* the new prompt against every topic and open proposal, and every earlier prompt against the new proposal, on a 1–5 rubric (5 = squarely about this topic … 1 = unrelated).

The judge score $j_{pc}$ is rescaled to $s_{pc} = (j_{pc}-1)/4 \in \{0, 0.25, 0.5, 0.75, 1\}$. Each score is asked once, when both the prompt and the topic exist, so later prompts never influence earlier scores.

**Sets** (per step). $G^{old}$ / $G^{new}$: existing groups / groups an open proposal would create. $C^{old}$ / $C^{new}$: existing topics / open proposals, $C = C^{old}\cup C^{new}$. $\pi(c)$: parent of $c$ (fixed; chosen by the LLM for proposals); $K(c)$: subtopics of $c$. $P^{old}$: prompts in the forest, $p$ in topic $c^0(p)$; $n$: the new prompt; $P = P^{old}\cup\{n\}$. $w_p = 1$: move weight of a prompt (assumption; could reflect how recently it was opened).

**Decision variables.**

| variable | meaning |
|---|---|
| $q_{pc}\in\{0,1\}$ | prompt $p$ is in topic $c$ after the step |
| $y_c\in\{0,1\}$ | topic $c$ exists after the step (old: kept / deleted; proposal: created) |
| $g_G\in\{0,1\}$ | new group $G$ is created |
| $m_p\in\{0,1\}$ | old prompt $p$ is moved |
| $z\in\{0,1\}$ | the step is a restructure |
| $o_c, u_c \ge 0$ | amount by which topic $c$ is over $U$ / under $L$ |

**Constraints.**

$$
\begin{aligned}
&\textstyle\sum_{c} q_{pc} = 1 \;\;\forall p && \text{(1) each prompt in one topic}\\
&q_{pc} \le y_c && \text{(2) only into existing topics}\\
&\textstyle y_c \le \sum_p q_{pc} + \sum_{k\in K(c)} y_k && \text{(3) no empty topics (emptied old topics are deleted)}\\
&y_c \le y_{\pi(c)} \;\text{ if } \pi(c) \text{ is a topic} && \text{(4) a branch needs its parent}\\
&y_c \le g_G,\;\; g_G \le \textstyle\sum_{\pi(c)=G} y_c && \text{(5) a new group exists iff its tree does}\\
&\textstyle\sum_p q_{pc} \le U + o_c && \text{(6) too full (soft)}\\
&\textstyle\sum_p q_{pc} + \sum_{k\in K(c)} y_k \ge L\,y_c - u_c && \text{(7) too sparse (soft)}\\
&m_p = 1 - q_{p,c^0(p)} && \text{(8) track moves}\\
&m_p \le z,\;\; 1 - y_c \le z \;\;(c\in C^{old}) && \text{(9) a move or deletion is a restructure}\\
&\textstyle\sum_{c\in C^{new}} y_c \le \texttt{MAX\_NEW}=1 && \text{(10) slow growth}
\end{aligned}
$$

**Outcome.** With $c^*$ the topic of the new prompt: $c^*$ old → (a); new with a topic as parent → (b); new under an old group → (c); new under a new group → (d); $z = 1$ → (e). The largest step has 141 variables and 176 constraints, well within the pip license (2000 each).

---

## 3. Definition of the objective function (≈ 1 page)

$$
\max\;
\underbrace{\sum_{p,c} s_{pc}\,q_{pc}}_{\text{fit}}
-\underbrace{\lambda\sum_{c\in C^{new}} y_c-\lambda_G\sum_{G} g_G}_{\text{growth}}
-\underbrace{\beta\sum_{c} (o_c+u_c)}_{\text{imbalance}}
-\underbrace{\mu\sum_{p} w_p\,m_p - F\,z}_{\text{disruption}}
$$

The fit is summed over **all** prompts, old ones included: moving an old prompt into a better topic raises the fit, which is what makes (e) worthwhile, and the disruption terms price it. Without the growth, imbalance and disruption terms the optimum would be "every prompt in its best-scoring topic", i.e. the greedy rule H2; these terms create the trade-off.

**Weights** (§3). All weights are on the scale of $s$, where one judge level is 0.25.

| | value | justification |
|---|---|---|
| $U$ | 3 | preferred max prompts per topic; small so overload happens in a short session (real use ≈ 5–7) |
| $L$ | 2 | preferred min size (prompts + subtopics): a one-prompt topic adds a row but no grouping |
| $\lambda$ | 0.20 | a new topic must gain about one judge level |
| $\lambda_G$ | 0.30 | a new group is the most visible change. A prompt of a new subject (fit 1 to its proposal) still opens one if every existing topic fits it at most loosely: $1-\lambda-\lambda_G-\beta = 0.38 > 0.25$ |
| $\beta$ | 0.12 | about half a judge level; off the 0.05 grid so that two options never tie |
| $\mu$ | 0.10 | per moved prompt |
| $F$ | 0.15 | fixed cost of any restructure: the first change to a familiar structure is the most noticeable |

**Assumptions about user behaviour.** Students look for a prompt in the topic that matches its meaning (fit); long topics are slow to scan and one-prompt topics add clutter ($U$, $L$, $\beta$); every visible change, and especially a moved prompt, costs re-orientation ($\mu$, $F$, $\lambda$, $\lambda_G$). The values are educated guesses; the what-if analysis (Section 4) shows which decisions depend on them.

**Worked examples** (they match the solver's objective values).
- *Step 1, "What does the learning rate do?"*: adding it to *Gradient descent* (score 4) gives 2.63; opening *Learning rate* (score 5) gives 3.00 − 0.20 − 0.24 = 2.56. One extra judge level does not pay for a one-prompt topic, so the IP waits: (a), margin 0.07.
- *Step 3, "Chain rule through a 2-layer network"*: creating *Backpropagation*, placing the new prompt there **and moving** the earlier backprop prompt $n_2$ gives 4.75 − 0.20 − 0.12 − (0.10 + 0.15) = 4.18; the same without the move leaves a one-prompt topic (4.06); the best existing topic gives 4.00. Outcome (e).
- *Step 5, "How do I find the eigenvalues of a 2x2 matrix?"*: rated 1 against every deep learning topic. A new group gains 1 − 0.20 − 0.30 − 0.12 = +0.38, the best existing topic only +0.12. Outcome (d), margin 0.26.

**Model citation.** Proposals and scores: Claude Haiku 5.5 (`claude-haiku-5-5`, Anthropic), via the Claude Code CLI, one fresh call per question, 26 Nov 2026. Prompts and raw answers are in `llm_steps/`; the notebook replays these frozen answers, so it runs without any LLM call.

---

## 4. Analysis of the resulting designs (≈ 1 page)

**The optimal design** (§5b, §6). Outcomes over the 11 steps: `a a e a d e a a e a c`.

> **[Figure 1]** `show_session(ip_history)`: the forest after every step (§6).
> **[Figure 2]** `show_step(ip_history, k=3)`: step 3 before/after, the first restructure.

The pattern: for the first question of a theme the IP keeps it in the closest existing topic (steps 1, 2, 4, 7); when a second one arrives it creates the proposed topic and moves the first one in (steps 3, 6, 9). A new subject immediately gets its own group (step 5), and the SVD question opens a second tree in it (step 11). For every step we also solved for the second-best decision (excluding the optimum with a no-good cut $\sum_p q_{p,a(p)} \le |P|-1$): margins range from 0.07 to 0.32 (§6).

**Alternative designs** (§7), on the same session and LLM answers:
- **H0 – chronological**: blocks of three prompts in arrival order, as in today's chat sidebars;
- **H1 – best existing topic**: never creates a topic;
- **H2 – greedy best match**: always takes the highest-scoring option, including proposals ("best option everywhere").

We measure agreement with a **hand-made ideal forest** (written before the LLM answers were collected, never shown to the LLM or solver) by pairwise F1 over "these two prompts share a topic / a tree", which is independent of topic names and of the LLM's scores.

| | F1 topic | F1 tree | mean fit | topics | one-prompt topics | moves |
|---|---|---|---|---|---|---|
| H0 chronological | 0.24 | 0.22 | – | 6 | 2 | 0 |
| H1 best existing | 0.28 | 0.53 | 0.52 | 2 (both over $U$) | 0 | 0 |
| H2 greedy | **0.62** | **0.63** | **1.00** | 8 | 4 | 0 |
| **IP** | 0.57 | **0.63** | 0.98 | 7 | **2** | 3 |

> **[Figure 3]** `show_final_trees(HISTORIES)`: the four final forests side by side (§7).

H0 mixes subjects in one block; H1 piles everything into two overloaded topics and files linear algebra under *Deep learning basics*. H2 fits best but fragments the forest into one-question topics. The IP reaches the same tree-level agreement as H2 with a tidier forest; its lower topic-level F1 comes from a single pair: "What does the learning rate do?" never got a second question on its theme, so it stays in *Gradient descent*, while our ideal forest puts it with the optimizers. The price of the IP is 3 moves, each at a predictable moment (the second question of a theme).

**What-if** (§8; the whole session re-solved with the stored LLM answers).

| change | effect |
|---|---|
| $F \le 0.25$ | no change |
| $F = 0.40$ or $U = 2$ | no moves at all: topics are opened at the first question |
| $\lambda \le 0.1$ | identical to the greedy rule H2 |
| $\lambda \ge 0.4$ | coarse forest with an overloaded topic, F1 0.40 |
| $\lambda_G \ge 0.6$ | the new group is delayed to the second linear algebra question (then created with a move) |

**Critical examination** (§9).
- *Inputs.* One run of one model, not compared with human ratings; the smallest margins (0.07) mean one judge level in one score can flip a decision. The CLI has no temperature setting, so a rerun can differ (a topic name changed between two collections); reproducibility relies on the frozen answers. The baselines and what-if runs reuse answers collected along the IP's own path (no unrated pair was needed here, but the LLM might have proposed other topics on other paths). The LLM's parent choice is taken as is (e.g. *Backpropagation* under *Gradient descent*).
- *Model.* Myopic: waiting for a second question costs a move later, and a topic whose second question never comes is never created. Weights are assumptions. Topics are never moved, renamed or merged; at most one new topic per step.
- *Evaluation.* One short scripted session written by us; the ideal forest is one reasonable grouping among several and has only 7 "together" pairs, so one pair moves F1 by about 0.05. All metrics are proxies; whether students find their prompts faster is tested in Milestone 4.

**Use in the prototype.** The IP's forest after every step is exported to `export/ip_forest_sequence.json` (§10) and is condition B of the Milestone 4 A/B test; condition A is the chronological list (H0) or the greedy rule (H2).

---

### Still to do for the submission
- [ ] Shorten to ≤ 3.5 pages of text; paste Figures 1–3 from the notebook.
- [ ] Group review of the ideal forest in `session.py` (`IDEAL`).
- [ ] Blog post with links to the optimization task, the resulting designs and this analysis.
- [ ] Copy `ui_optimization.ipynb` and `requirements.txt` (and the PDF) to `Deliverables/UIOptimization/` of the group repository; also copy `session.py`, `judge_prompt.py`, `visualization.py` and `llm_steps/`, so the notebook runs from the zip without downloading this repository.
