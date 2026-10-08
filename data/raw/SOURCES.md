# Raw sources

Everything the lexicon build reads from `data/raw/`, where it came from, and
when. The big dumps are git-ignored (`.gitignore`); re-download them to
reproduce a build. Licences (verify before shipping — see the Credits page in
the app): CC-CEDICT and Wiktionary are CC BY-SA 4.0, the MOE dictionary is
CC BY-ND 3.0 TW (shown verbatim), Unihan is under the Unicode terms of use.

| file | what | source URL | downloaded | committed |
| --- | --- | --- | --- | --- |
| `tocfl-words.xlsx` | TOCFL 2023 word list, 7 levels (準備級一/二級, 入門, 基礎, 進階, 高階, 流利) | https://tocfl.edu.tw/assets/files/vocabulary/8000zhuyin_202307.zip | pre-existing | yes |
| `dict-revised-translated.json.xz` | MOE 重編國語辭典修訂本 with CC-CEDICT-derived English (`translation.English`) | https://github.com/g0v/moedict-data (translated build) | pre-existing | yes |
| `dict-revised.json.xz`, `dict_revised_1.xlsx` | MOE dictionary, Chinese only | https://language.moe.gov.tw/ | pre-existing | yes |
| `ivankra-tocfl-cedict.csv` | TOCFL list merged with CC-CEDICT definitions **per reading** — the per-reading English source | https://raw.githubusercontent.com/ivankra/tocfl/master/tocfl-cedict.csv | 2026-10-01 | yes (0.7 MB) |
| `ivankra-top-20111208.csv` | Old SC-TOP list (2011) with terse English glosses — **build-time sense hint only** (licence unclear, never shown as a source) | https://raw.githubusercontent.com/ivankra/tocfl/master/top-20111208.csv | 2026-10-01 | yes (0.5 MB) |
| `ivankra-tocfl-202307.csv` | Parsed 2023 TOCFL list (used to cross-check level counts) | https://raw.githubusercontent.com/ivankra/tocfl/master/tocfl-202307.csv | 2026-10-01 | yes |
| `kaikki-chinese.jsonl` | English Wiktionary, Chinese entries, via wiktextract (≈1.2 GB) — Taiwan/Mainland tagged senses | https://kaikki.org/dictionary/Chinese/kaikki.org-dictionary-Chinese.jsonl.gz (gunzip to this name) | 2026-10-01 | no (ignored) |
| `cedict_1_0_ts_utf-8_mdbg.zip` | Latest CC-CEDICT release | https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.zip | 2026-10-01 — **not read by the build yet**: CC-CEDICT arrives per reading through the ivankra merge | no (ignored) |
| `Unihan_Readings.txt` (from `Unihan.zip`) | Per-character definitions (`kDefinition`) for the character-breakdown help → `data/build/char-glosses.v1.json` | https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip | 2026-10-01 | no (ignored) |
| `Unihan_IRGSources.txt`, `Unihan_DictionaryLikeData.txt` (from `Unihan.zip`) | Phase 23 look-alike characters: radical + strokes (`kRSUnicode`, `kTotalStrokes`) and phonetic groups (`kPhonetic`) → `packages/core/src/data/char-shapes.generated.ts` (`pnpm --filter @anan/data-pipeline gen:char-shapes`). unicode.org was unreachable from the build machine on 2026-10-08, so these two files were written from the same Unihan fields in the `cjk-unihan` npm package's database | https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip | 2026-10-08 | no (ignored) |

The build still runs without the optional files: `build-lexicon.ts` skips each
optional source whose file is absent and records which sources were used in
`data/build/lexicon.v2.json` → `meta.glossSourceFiles`.

kaikki.org throttles each connection to ≈25 KB/s, so fetch the 155 MB `.gz`
with parallel range requests (e.g. 20 × `curl -r start-end`, then `cat` the
parts and `gunzip`), which takes about 8 minutes. To rebuild:

```sh
pnpm --filter @anan/data-pipeline build:lexicon      # picks up Wiktionary + Unihan
pnpm --filter @anan/data-pipeline build:glosses      # LLM adjudication (needs a key in apps/proxy/.env)
pnpm --filter @anan/data-pipeline build:lexicon      # applies the validated answers
```

Chinese Wordnet (CWN) is deliberately **not** used (unclear licence).
