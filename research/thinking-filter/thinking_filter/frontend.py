"""Calls the app's own TypeScript (bridge.ts) so prompts and word rules never drift from the frontend."""
import json
import subprocess

from .files import ROOT

BRIDGE = ROOT / "bridge.ts"


def _run(request: dict):
    done = subprocess.run(["node", str(BRIDGE)], input=json.dumps(request), capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise RuntimeError(f"bridge.ts failed (exit {done.returncode}): {done.stderr.strip()[:2000]}")
    return json.loads(done.stdout)


def thinking_input(text: str, tutor: str | None) -> dict:
    """The app's ScoreInput for "how much of the thinking is the student's own?". With a tutor
    message it goes in as the conversation history (`recent`), as the app sends earlier turns."""
    recent = [{"role": "assistant", "text": tutor}] if tutor else []
    return {"question": "thinking", "text": text, "recent": recent}


def score_prompts(inputs: list[dict]) -> list[dict]:
    """[{system, user, scale}] rendered by the frontend's scorePrompt()."""
    return _run({"op": "score_prompt", "inputs": inputs})


_rules_memo: dict[str, dict] = {}


def word_rules(texts: list[str]) -> list[dict]:
    """[{mode, confidence, reasons, share}] from the frontend's classify() and draftShare(), one bridge
    call for all texts not seen before in this process."""
    new = list(dict.fromkeys(t for t in texts if t not in _rules_memo))
    if new:
        _rules_memo.update(zip(new, _run({"op": "rules", "texts": new})))
    return [_rules_memo[t] for t in texts]


def constants() -> dict:
    """{OWN_FROM, AI_UP_TO, THINKING_SCALE} from modes.ts and score.ts: where a percent becomes a label."""
    return _run({"op": "constants"})
