"""Write the three scripted sessions and their draft gold labels.

DRAFT: prompts and gold paths were written by Claude Opus 5.5 (claude-opus-5-5) on 23 Nov 2026 for
the group to review for realism (plan Phase 1). Until a group member has reviewed them, every number
computed against these labels is a draft number.

Run: python scripts/draft_sessions.py   (overwrites data/sessions/*.json and data/gold/*.csv)
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DRAFTED_BY = "claude-opus-5-5 (draft, 2026-11-23); needs review by the group"

DL = "Deep Learning"
BP = f"{DL} > Backpropagation"
TR = f"{DL} > Training"

# (chat, text, gold path). The gold topic is the last element of the path.
S1 = [
    ("c1", "We're doing backprop on exercise sheet 4. Can you explain what backpropagation actually computes? I get that it's the gradient but not why it goes backwards.", BP),
    ("c1", "For a 2-layer MLP with sigmoid hidden units I wrote dL/dW1 = dL/dy * W2 * x. Is that missing something?", f"{BP} > Chain rule"),
    ("c1", "how does the chain rule work on a computational graph when one node feeds into two others?", f"{BP} > Chain rule"),
    ("c1", "Why do people use ReLU instead of sigmoid in hidden layers?", f"{DL} > Activation functions"),
    ("c1", "I computed the gradient of the loss wrt the bias in layer 1 as the sum of the deltas over the batch. Is summing right or should it be the mean?", BP),
    ("c1", "what is the derivative of tanh? I think it's 1 - tanh^2 but I'm not sure why", f"{DL} > Activation functions"),
    ("c1", "In the computational graph for f = (x+y)*z, what are the local gradients at each node?", f"{BP} > Chain rule"),
    ("c1", "Our network trains fine with 3 layers but with 10 layers the loss barely moves. Is that the vanishing gradient problem?", f"{BP} > Vanishing gradients"),
    ("c1", "What's the derivative of softmax combined with cross-entropy? The sheet says it simplifies to y_hat - y", f"{BP} > Softmax and cross-entropy gradient"),
    ("c1", "Leaky ReLU vs ReLU, does the small negative slope really matter in practice?", f"{DL} > Activation functions"),
    ("c1", "Should I use SGD or Adam for the exercise? The sheet doesn't say.", f"{TR} > Optimizers"),
    ("c1", "Why exactly does the gradient shrink layer by layer with sigmoid? Is it because the derivative is at most 0.25?", f"{BP} > Vanishing gradients"),
    ("c1", "How do I do gradient checking with finite differences? What epsilon should I pick?", f"{BP} > Gradient checking"),
    ("c1", "My gradient check gives a relative error of 1e-3. Is that good enough or is my backward pass wrong?", f"{BP} > Gradient checking"),
    ("c1", "Does ReLU fix vanishing gradients completely, or can it still happen?", f"{BP} > Vanishing gradients"),
    ("c1", "What does momentum do in SGD, intuitively?", f"{TR} > Optimizers"),
    ("c1", "When I backprop through a max pooling layer, where does the gradient go?", BP),
    ("c1", "Do residual connections help with vanishing gradients? How?", f"{BP} > Vanishing gradients"),
    ("c2", "My learning rate of 0.1 makes the loss explode and 0.001 is super slow. How do people choose the learning rate?", f"{TR} > Optimizers"),
    ("c2", "What's the bias correction in Adam for? I don't get why the first steps are biased.", f"{TR} > Optimizers"),
    ("c2", "Xavier vs He initialization, which one goes with ReLU and why?", f"{TR} > Weight initialization"),
    ("c2", "Why can't we just initialize all weights to zero?", f"{TR} > Weight initialization"),
    ("c2", "How does dropout work at test time? Do I scale the weights?", f"{TR} > Regularization"),
    ("c2", "Is L2 regularization the same as weight decay?", f"{TR} > Regularization"),
    ("c2", "In the backward pass of batch norm, why does the gradient have three terms?", BP),
    ("c2", "I keep confusing myself: in the chain rule for vectors, when do I transpose the Jacobian?", f"{BP} > Chain rule"),
    ("c2", "Is gradient clipping the fix for exploding gradients, like the opposite of the vanishing problem?", f"{BP} > Vanishing gradients"),
    ("c2", "I derived dL/dz for softmax + cross-entropy and got y_hat - y, but only for a single example. How does it look for a batch?", f"{BP} > Softmax and cross-entropy gradient"),
    ("c2", "learning rate schedules: is cosine decay better than step decay?", f"{TR} > Optimizers"),
    ("c2", "Can you quiz me on backprop? Give me a small network and I'll compute the gradients myself.", BP),
]
S1_ACCESS = [(12, 8), (15, 12), (20, 11), (26, 3), (28, 9)]  # (step, prompt number opened)

LA, PR, DB = "Linear Algebra", "Probability", "Databases"
S2 = [
    ("c1", "How do I find the eigenvalues of a 2x2 matrix? I know it's det(A - λI) = 0 but I get lost after that.", f"{LA} > Eigenvalues"),
    ("c1", "What does it mean geometrically that a vector is an eigenvector?", f"{LA} > Eigenvalues"),
    ("c1", "What's the difference between P(A|B) and P(B|A)? I always mix them up.", f"{PR} > Conditional probability"),
    ("c1", "A test is 99% accurate and the disease has 1% prevalence. If I test positive, what's the chance I have it? I got 99% but that seems wrong.", f"{PR} > Conditional probability > Bayes' theorem"),
    ("c1", "When is a matrix diagonalizable? Is it enough that the eigenvalues are distinct?", f"{LA} > Eigenvalues > Diagonalization"),
    ("c1", "What's the difference between an INNER JOIN and a LEFT JOIN?", f"{DB} > SQL joins"),
    ("c1", "Are independent events the same as mutually exclusive events?", f"{PR} > Conditional probability"),
    ("c1", "How do I compute the rank of a matrix with row reduction?", f"{LA} > Matrix rank"),
    ("c1", "My LEFT JOIN returns more rows than the left table has. How is that possible?", f"{DB} > SQL joins"),
    ("c1", "Is the rank of A the same as the rank of A transpose? Why?", f"{LA} > Matrix rank"),
    ("c1", "How do I compute the expected value of a die roll?", f"{PR} > Random variables > Expectation and variance"),
    ("c1", "What is 3NF and how do I check if my schema is in it?", f"{DB} > Normalization"),
    ("c1", "What's the difference between SVD and eigendecomposition?", f"{LA} > SVD"),
    ("c1", "Var(X+Y) = Var(X) + Var(Y), does that only hold if X and Y are independent?", f"{PR} > Random variables > Expectation and variance"),
    ("c1", "When should I add an index to a column?", f"{DB} > Indexes"),
    ("c2", "How is SVD used for low-rank approximation of an image?", f"{LA} > SVD"),
    ("c2", "When should I use a binomial vs a Poisson distribution?", f"{PR} > Distributions"),
    ("c2", "If a matrix has eigenvalue 0, does that mean it's not invertible?", f"{LA} > Eigenvalues"),
    ("c2", "Why is a B-tree index good for range queries but a hash index isn't?", f"{DB} > Indexes"),
    ("c2", "Can you explain the law of total probability with an example?", f"{PR} > Conditional probability"),
    ("c2", "I diagonalized A = PDP^-1, how do I use that to compute A^10?", f"{LA} > Eigenvalues > Diagonalization"),
    ("c2", "How do I write a query that finds customers with no orders?", f"{DB} > SQL joins"),
    ("c2", "What is a probability density function, and why can it be bigger than 1?", f"{PR} > Random variables"),
    ("c2", "Is denormalization ever a good idea?", f"{DB} > Normalization"),
    ("c2", "Is the number of nonzero singular values equal to the rank?", f"{LA} > SVD"),
    ("c2", "Bayes: prior, likelihood, posterior, which is which in the formula?", f"{PR} > Conditional probability > Bayes' theorem"),
    ("c2", "What's a functional dependency? The lecture defines it but I don't see the point.", f"{DB} > Normalization"),
    ("c2", "Is the normal distribution's 68-95-99.7 rule exact?", f"{PR} > Distributions"),
    ("c2", "Does an index slow down INSERTs?", f"{DB} > Indexes"),
    ("c2", "Can you check my query: SELECT name, COUNT(*) FROM orders JOIN customers USING (id) GROUP BY name. Is joining on id right?", f"{DB} > SQL joins"),
]
S2_ACCESS = [(9, 1), (19, 4), (25, 5), (28, 6)]

ML = "Machine Learning"
TF = f"{ML} > Transformers"
S3 = [
    ("c1", "What's the difference between supervised and unsupervised learning?", f"{ML} > ML basics"),
    ("c1", "Why do we need a separate test set if we already have a validation set?", f"{ML} > ML basics > Model evaluation"),
    ("c1", "What is overfitting and how can I tell it's happening from the loss curves?", f"{ML} > Overfitting"),
    ("c1", "Can you explain the bias-variance tradeoff with a simple example?", f"{ML} > Overfitting"),
    ("c1", "How does k-fold cross-validation work?", f"{ML} > ML basics > Model evaluation"),
    ("c1", "Is accuracy a bad metric for imbalanced classes? What should I use instead?", f"{ML} > ML basics > Model evaluation"),
    ("c1", "Why does L1 regularization give sparse weights but L2 doesn't?", f"{ML} > Overfitting"),
    ("c1", "What problem do recurrent neural networks solve that feedforward ones don't?", f"{ML} > Sequence models"),
    ("c1", "Why do LSTMs have gates? What's the forget gate for?", f"{ML} > Sequence models"),
    ("c1", "What's the problem with RNNs on long sentences?", f"{ML} > Sequence models"),
    ("c2", "What is attention in seq2seq models? The decoder 'looks at' the encoder states?", f"{TF} > Attention"),
    ("c2", "In self-attention, what are queries, keys and values? Where do they come from?", f"{TF} > Attention"),
    ("c2", "Why do we divide by sqrt(d_k) in scaled dot-product attention?", f"{TF} > Attention"),
    ("c2", "How does the transformer know the word order if attention is permutation invariant?", f"{TF} > Positional encoding"),
    ("c2", "Why sinusoidal positional encodings instead of just learning position embeddings?", f"{TF} > Positional encoding"),
    ("c2", "What's the point of multi-head attention? Isn't one head enough?", f"{TF} > Multi-head attention"),
    ("c2", "I tried to compute attention weights by hand for 3 tokens: softmax of QK^T. Is each row supposed to sum to 1?", f"{TF} > Attention"),
    ("c2", "How does the causal mask work in the decoder?", f"{TF} > Masking"),
    ("c2", "Is the transformer encoder the same as BERT?", TF),
    ("c2", "How do the heads get combined after multi-head attention, just concatenation?", f"{TF} > Multi-head attention"),
    ("c2", "Why is attention O(n^2) in sequence length? Is that why context windows are limited?", f"{TF} > Attention"),
    ("c2", "What's the difference between self-attention and cross-attention in the decoder?", f"{TF} > Attention"),
    ("c2", "Do I add or concatenate the positional encoding to the token embedding?", f"{TF} > Positional encoding"),
    ("c2", "What does the padding mask do, and how is it different from the causal mask?", f"{TF} > Masking"),
    ("c2", "Can you quiz me on the transformer architecture? I want to check I understand the whole forward pass.", TF),
]
S3_ACCESS = [(12, 11), (16, 12), (21, 13), (24, 18)]

SESSIONS = {
    "s1_focused": ("One course (neural networks exercise sheet); many prompts on backpropagation, so topics overflow and splits become worthwhile.", S1, S1_ACCESS),
    "s2_mixed": ("Three subjects (linear algebra, probability, databases) interleaved across two chats, so new trees and new groups are needed.", S2, S2_ACCESS),
    "s3_drift": ("Starts broad (machine learning basics), then narrows into attention and transformers, so renames and re-parenting become worthwhile.", S3, S3_ACCESS),
}


def main() -> None:
    for sid, (desc, rows, access) in SESSIONS.items():
        prefix = sid.split("_")[0]
        prompts = [{"id": f"{prefix}_p{i:02d}", "text": text, "step": i, "chat_id": chat}
                   for i, (chat, text, _) in enumerate(rows, 1)]
        events = [{"step": step, "prompt_id": f"{prefix}_p{n:02d}"} for step, n in access]
        session = {"session_id": sid, "draft": True, "drafted_by": DRAFTED_BY, "description": desc,
                   "prompts": prompts, "access_events": events}
        out = ROOT / "data" / "sessions" / f"{sid}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(session, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

        gold = ROOT / "data" / "gold" / f"{sid}.csv"
        gold.parent.mkdir(parents=True, exist_ok=True)
        with gold.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["prompt_id", "text", "gold_topic", "gold_path", "labelled_by"])
            for p, (_, text, path) in zip(prompts, rows):
                w.writerow([p["id"], text, path.split(" > ")[-1], path, DRAFTED_BY])

        template = ROOT / "data" / "gold" / f"{sid}_template.csv"
        with template.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["prompt_id", "text", "rater", "gold_topic", "gold_path", "comment"])
            for p in prompts:
                w.writerow([p["id"], p["text"], "", "", "", ""])
        print(f"{sid}: {len(prompts)} prompts, {len(events)} access events, "
              f"{len({r[2] for r in rows})} gold topics")


if __name__ == "__main__":
    main()
