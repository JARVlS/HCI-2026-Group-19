"""Print the text outputs of an executed notebook (for checking the findings cells)."""
import sys

import nbformat

for path in sys.argv[1:]:
    nb = nbformat.read(path, as_version=4)
    for i, c in enumerate(nb.cells):
        if c.cell_type != "code":
            continue
        for o in c.get("outputs", []):
            if o.output_type == "stream":
                txt = o.text
            elif "data" in o and "text/plain" in o.data:
                txt = o.data["text/plain"]
            elif o.output_type == "error":
                txt = "ERROR " + o.ename + ": " + o.evalue
            else:
                continue
            if txt.strip():
                print(f"--- cell {i}\n{txt.rstrip()[:2500]}")
