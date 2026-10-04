"""Dump per-page text of a textbook PDF (PyMuPDF) to JSON: {"pages": {"13": "..."}}.

Usage: python3 extract_pages.py <in.pdf> <out.json>
Cleaning/parsing is done in TypeScript (lib/curriculum/) so it is unit-tested.
"""
import json
import sys

import pymupdf

src, dst = sys.argv[1], sys.argv[2]
doc = pymupdf.open(src)
pages = {str(i): p.get_text() for i, p in enumerate(doc, 1)}
with open(dst, "w", encoding="utf-8") as f:
    json.dump({"pages": pages}, f, ensure_ascii=False)
print(f"{len(pages)} pages -> {dst}")
