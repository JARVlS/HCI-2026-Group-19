"""Assemble the Milestone 3 hand-in folder (Deliverables/UIOptimization in the course layout).

    python scripts/package_submission.py [target dir]   (default: dist/UIOptimization, git-ignored)

Copies ui_optimization.ipynb, forest/, config/, the sessions, the gold labels and the frozen cache,
and requirements-submission.txt as requirements.txt. The PDF report is added by the group.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main(target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    shutil.copy(ROOT / "ui_optimization.ipynb", target / "ui_optimization.ipynb")
    shutil.copy(ROOT / "requirements-submission.txt", target / "requirements.txt")
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
    shutil.copytree(ROOT / "forest", target / "forest", ignore=ignore)
    shutil.copytree(ROOT / "config", target / "config", ignore=ignore)
    for sub in ("sessions", "gold", "frozen"):
        shutil.copytree(ROOT / "data" / sub, target / "data" / sub, ignore=ignore)
    print(f"packaged into {target}")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "dist" / "UIOptimization")
