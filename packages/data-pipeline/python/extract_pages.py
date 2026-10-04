"""Dump per-page text of a textbook PDF (PyMuPDF) to JSON: {"pages": {"13": "..."}}.

Usage: python3 extract_pages.py <in.pdf> <out.json> [--glyph-decode]

Cleaning/parsing is done in TypeScript (lib/curriculum/) so it is unit-tested.

`--glyph-decode` is for PDFs whose body fonts carry no Unicode map (來學華語 3):
MuPDF then reports U+FFFD for those glyphs and the text comes out as garbage.
Each such glyph is decoded from its glyph id instead:
  * DFPBiaoKai ZhuIn (Big5 order): gid = 15584 + index of the Big5 code counted
    from 0xA440 with 157 codes per lead byte (verified against the book's own
    "Read aloud" text by `curriculum:import`'s decode check);
  * DFPBiaoKai PoIn (alternate readings of polyphones): gid is the Unicode code point;
  * Times New Roman / Arial: gid + 29 for ASCII, and the pinyin letters/ligatures below.
Anything not understood stays U+FFFD and is counted in the printed summary.
"""
import json
import sys
from collections import Counter

import pymupdf

LATIN_GIDS = {
    # tone-marked vowels (two glyph sets are in use, hence the duplicates)
    105: "á", 106: "à", 112: "é", 113: "è", 116: "í", 117: "ì", 121: "ó", 122: "ò", 126: "ú", 127: "ù",
    406: "Ā", 407: "ā", 413: "ē", 431: "ī", 447: "Ō", 448: "ō", 460: "ū", 268: "ě",
    1277: "ǎ", 1279: "ǐ", 1281: "ǒ", 1283: "ǔ", 1289: "ǚ",
    897: "ǎ", 899: "ǐ", 901: "ǒ", 903: "ǔ", 911: "ǜ",
    # punctuation and ligatures
    171: "…", 179: "“", 180: "”", 182: "’", 191: "ﬁ", 192: "ﬂ", 3445: "ﬀ", 3446: "ﬃ",
}
# DFPBiaoKai "PoIn" glyphs: alternate-reading forms of polyphonic characters, in
# an order of their own. Identified once by aligning every occurrence with the
# book's clean "Read aloud" text.
POIN_GIDS = {
    28644: "一", 31826: "一", 28648: "了", 28660: "子", 28662: "不", 32471: "差", 28760: "地",
    28794: "西", 28888: "亞", 28985: "爸", 28991: "空", 29037: "哇", 29070: "星", 29091: "為",
    29098: "相", 29145: "們", 29150: "個", 29181: "差", 29263: "假", 29278: "啊", 29305: "得",
    29363: "處", 29824: "調", 29929: "應", 29990: "還", 32086: "漂", 32374: "和", 32384: "思", 29319: "教", 3858: "", 28856: "更", 29528: "嗨",
}
ZHUIN_BASE = 15584
LEVEL1 = 5401


def zhuin_char(gid: int) -> str:
    idx = gid - ZHUIN_BASE
    if not 0 <= idx < LEVEL1:
        return "\ufffd"
    row, col = divmod(idx, 157)
    lo = 0x40 + col if col < 63 else 0xA1 + (col - 63)
    try:
        return bytes([0xA4 + row, lo]).decode("big5")
    except UnicodeDecodeError:
        return "\ufffd"


def decode_glyph(font: str, gid: int) -> str:
    if "DFPBiaoKai" in font:
        if "ZhuIn" in font:
            return zhuin_char(gid)
        return POIN_GIDS.get(gid, "\ufffd")
    if "TimesNewRoman" in font or "Arial" in font:
        if 3 <= gid <= 98:
            return chr(gid + 29)
        return LATIN_GIDS.get(gid, "\ufffd")
    return "\ufffd"


def page_text_decoded(page, bad: Counter) -> str:
    def key(o):
        return (round(o[0], 1), round(o[1], 1))

    trace = {}
    for sp in page.get_texttrace():
        for c in sp["chars"]:
            trace[key(c[2])] = (c[0], c[1])
    lines = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            out = []
            for span in line["spans"]:
                for ch in span["chars"]:
                    t = trace.get(key(ch["origin"]))
                    if t is not None and t[0] == 0xFFFD:
                        d = decode_glyph(span["font"], t[1])
                        if d == "\ufffd":
                            bad[(span["font"], t[1])] += 1
                        out.append(d)
                    else:
                        out.append(ch["c"])
            lines.append("".join(out))
    return "\n".join(lines) + "\n"


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    decode = "--glyph-decode" in sys.argv[3:]
    doc = pymupdf.open(src)
    bad: Counter = Counter()
    pages = {
        str(i): (page_text_decoded(p, bad) if decode else p.get_text())
        for i, p in enumerate(doc, 1)
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"pages": pages}, f, ensure_ascii=False)
    print(f"{len(pages)} pages -> {dst}")
    if decode:
        total = sum(bad.values())
        print(f"undecoded glyphs: {total} ({len(bad)} distinct)")
        for (font, gid), n in bad.most_common(12):
            print(f"  {font} gid {gid}: {n}")


main()
