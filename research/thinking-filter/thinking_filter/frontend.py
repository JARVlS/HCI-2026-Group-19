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


def word_rules(texts: list[str]) -> list[dict]:
    """[{mode, confidence, share}] from the frontend's classify() and draftShare()."""
    return _run({"op": "rules", "texts": texts})


def constants() -> dict:
    """{OWN_FROM, AI_UP_TO, THINKING_SCALE} from modes.ts and score.ts: where a percent becomes a label."""
    return _run({"op": "constants"})
