"""Build the notebooks from notebooks/src/*.py (jupytext percent format) and execute them.

    python scripts/build_notebooks.py                 # build and execute all
    python scripts/build_notebooks.py 04_ip 06_whatif # only these
    python scripts/build_notebooks.py --no-execute

Cells: '# %%' starts a code cell, '# %% [markdown]' a markdown cell (lines prefixed '# ').
ui_optimization.ipynb is built from notebooks/src/ui_optimization.py into the project root.
"""
import os
import sys
import time
from pathlib import Path

import nbformat
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "notebooks" / "src"


def parse(path: Path) -> nbformat.NotebookNode:
    nb = nbformat.v4.new_notebook()
    nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
    nb.metadata["language_info"] = {"name": "python"}
    cells: list[tuple[str, list[str]]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# %%"):
            cells.append(("markdown" if "[markdown]" in line else "code", []))
        elif cells:
            cells[-1][1].append(line)
    for kind, lines in cells:
        while lines and not lines[-1].strip():
            lines.pop()
        while lines and not lines[0].strip():
            lines.pop(0)
        if kind == "markdown":
            text = "\n".join(l[2:] if l.startswith("# ") else l.lstrip("#") for l in lines)
            nb.cells.append(nbformat.v4.new_markdown_cell(text))
        else:
            nb.cells.append(nbformat.v4.new_code_cell("\n".join(lines)))
    return nb


def target(name: str) -> Path:
    return ROOT / f"{name}.ipynb" if name == "ui_optimization" else ROOT / "notebooks" / f"{name}.ipynb"


def main(argv: list[str]) -> None:
    execute = "--no-execute" not in argv
    names = [a for a in argv if not a.startswith("--")] or sorted(p.stem for p in SRC.glob("*.py"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    for name in names:
        nb = parse(SRC / f"{name}.py")
        out = target(name)
        if execute:
            t0 = time.time()
            NotebookClient(nb, timeout=1800, kernel_name="python3",
                           resources={"metadata": {"path": str(out.parent)}}).execute()
            print(f"{name}: executed in {time.time() - t0:.0f}s")
        nbformat.write(nb, out)
        print(f"  -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main(sys.argv[1:])
