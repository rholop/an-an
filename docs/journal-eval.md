# Journal review eval

**Status: baseline not yet recorded.** Phase 5's acceptance criterion asks for the 10 fixture entries in
[`data/journal-eval/entries.v1.json`](../data/journal-eval/entries.v1.json) to be run through the *real* model and
each correction given a human verdict. That needs a Gemini key, which wasn't available when Phase 5 was
implemented, so this file is a placeholder rather than a result.

To record the baseline:

```sh
# terminal 1 — proxy with a real key in apps/proxy/.env
pnpm --filter @anan/proxy dev
# terminal 2 — overwrites this file with the model output
pnpm --filter @anan/proxy journal-eval
```

The script writes each entry, what we expected, the model's validated corrections and a `Verdict: _pending_` line per
correction, rewrite and bracket translation. Fill the verdicts in (✅ good / ⚠️ acceptable but wrong type or
explanation / ❌ wrong or harmful), commit, and re-run after every prompt change to compare.

## Fixture set (what a good run should look like)

| id | text | expected |
| --- | --- | --- |
| clean-night-market | 今天我跟朋友去夜市吃東西。我們吃了臭豆腐，很好吃。 | No issues; a correct entry must not be nitpicked. |
| le-placement | 我昨天吃飯了三碗。 | One error, `了-placement`: 吃了三碗飯. |
| mainland-vocab | 我每天坐地鐵去上班，用手機看視頻。 | Two `mainland_style`: 地鐵→捷運, 視頻→影片. |
| measure-word | 我有三個貓，牠們很可愛。 | One error, `measure-word`: 個→隻. |
| bi-construction | 我比他很高。 | One error: 我比他高 / 我比他高很多. |
| gaps | 週末我想去 [gym]，然後喝一杯 [bubble tea]。 | Nothing flagged inside brackets; 健身房, 珍珠奶茶 (or 波霸奶茶). |
| neng-hui | 我的朋友可以說很好的中文。 | At most one issue: 可以說→會說, medium confidence is fine. |
| mainland-online | 我在網上買了一個軟件。 | `mainland_style`: 網上→網路, 軟件→軟體. |
| short-correct | 我今天很累，所以早點睡覺。 | No issues. |
| many-errors-cap | 我昨天去了夜市吃飯了三碗，買東西了很多，我比朋友很高興，我有三個貓，我坐地鐵回家。 | Capped at 3, errors before style/mainland. |
