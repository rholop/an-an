# Audio (phase 10): verified Taiwan-standard pronunciation

Audio is **pre-generated, checked, and static**. Nothing is synthesized live; if a clip can't be trusted the app plays nothing.

## Voice choice

Engine: Azure Speech neural TTS, `zh-TW`. Candidates: `zh-TW-HsiaoChenNeural` (female, the build default) and `zh-TW-YunJheNeural` (male, `--voice=male`; also the fallback voice when a clip is flagged).

**Choice: `zh-TW-HsiaoChenNeural` (female).** Decided 2026-10-04 on a 50-word sample (evenly spaced across N1–L2), with no human listening: each clip was run back through Azure speech-to-text and compared with the source text. HsiaoChen: 8/50 mismatches, almost all single-syllable homophones STT can't tell apart (它→他, 姓→性, 狗→夠, 付→負, 要→藥). YunJhe: 17/50, including real misses on multi-syllable words (拖鞋→脫鞋, 冰箱→冰項, 搬家→班價). This catches gross errors only, not tone quality — the human review page is the real check.

Reproduce: `pnpm --filter @anan/data-pipeline audio:build --sample=50 --voice=female --out=/some/dir` (and `--voice=male`).

## Azure setup

Resource `an-an-speech` (Speech Services, free tier F0, region `eastus`, endpoint `https://eastus.api.cognitive.microsoft.com/`).

The key lives **only** in `packages/data-pipeline/.env` (gitignored; template `.env.example`):

```
AZURE_SPEECH_KEY=<KEY 1 from the portal>
AZURE_SPEECH_REGION=eastus
```

It must never be set for the proxy or the web build. `pnpm check:azure-key` (run in CI and on deploy) fails if `AZURE_SPEECH` appears in the web bundle/source or proxy, or if the real key value is found there.

Free tier: 0.5M neural characters/month, and Azure counts each Chinese character as **2**. The build prints billed characters per run (`--max-chars=N` stops cleanly at a budget; `--dry-run` estimates without calling Azure). Free-tier request limits are ~20/minute per endpoint, so the client waits ~3.2 s between calls and backs off on 429; a build is slow but resumable.

## Building

```
pnpm --filter @anan/data-pipeline audio:build                 # N1–L2 words + every textbook word + their sentences
pnpm --filter @anan/data-pipeline audio:build --levels=L3     # more later
```

- **Textbook words at any level (Phase 35):** every word tagged for a course book (`textbook:laixue-N`: core, supplementary and Phase 34 extra lesson words) gets a word clip whatever its level and whatever `--levels` says, so lesson words rated L3–L5 (e.g. 律師) have audio. No other words are added. `--dry-run` prints the textbook-word count separately.

- Output: `data/build/audio/words/{wordId}.mp3`, `sentences/{sentenceId}.mp3` (mono, 48 kbps) and `manifest.json` (id → file, voice, SSML hash, status, text).
- **Words** are synthesized alone, wrapped in `<phoneme alphabet="sapi">` with the lexicon's MOE zhuyin (neutral-tone `˙` moved after the syllable, which is how Azure writes it).
- **Sentences** are spoken naturally. Only *heteronym* tokens (還 長 行 得 了 重 著 為 調 樂 覺 和 … and any token whose lexicon readings differ) are wrapped, with the reading `resolveReading` chose, and **only when its confidence is `high`**. Otherwise the sentence is skipped and listed in `data/build/audio-review.md`. (`--accept-medium` also accepts readings a context rule picked.) 不/一 tone changes are never forced.
- Inputs: the lexicon, `data/build/sentences.v1.<level>.json`, and live sentences (phase 9) read from the newest saved copy of each profile in `apps/proxy/sync-data` (`--sync-dir=` to change).
- Idempotent/resumable: a clip is skipped when its SSML hash is unchanged. A rebuild with no changes makes zero Azure calls.
- Automatic check: each clip is run back through Azure speech-to-text (`zh-TW`); if the recognised characters differ from the text it is `suspect`. STT needs wav, so the clip is decoded with `ffmpeg` if installed; otherwise the same SSML is synthesized a second time as PCM (doubling characters).
- Statuses: `verified` (human OK), `auto_ok`, `suspect`, `flagged`. `playableClip` in core is the single gate: `verified` and `auto_ok` always play, `flagged` never does. **Current policy:** `suspect` clips also play, because no Mandarin-speaking reviewer is available yet (`ALLOW_SUSPECT_AUDIO` in `apps/web/src/lib/audio.ts`; they stay marked suspect). Set it to `false` once the review page has been worked through.

The mp3s are committed under `data/build/audio` so the existing deploy (git pull on the droplet) ships them; `pnpm --filter @anan/web sync:audio` copies them to `public/audio` (done by the web `dev`/`build`). If the folder gets too large for git, rsync it to the droplet instead.

## Human review

Open **Audio review** in the app (behind the household code). It plays the 500 most frequent words and a spread sample of 100 sentences one by one with zhuyin shown; **OK** / **Wrong** are saved on the proxy (`AUDIO_DIR`, default `apps/proxy/audio-data/audio-marks.json`), so either profile can do it. `suspect` clips come first; OK on one lets it play.

A mark is tied to the clip's hash: regenerate a clip and its old flag/OK stops applying.

## "Sounds wrong" and fixing

Every speaker button has a **Sounds wrong** link. It hides that clip at once on this device and on the server for both profiles, and lists it (clip, text, who, when) in the proxy's `audio-review.md` (also at `GET /v1/audio/review.md`).

```
pnpm --filter @anan/data-pipeline audio:pull-flags --url=https://holop.dev/an-an/api --code=<household code>
pnpm --filter @anan/data-pipeline audio:build --only-flagged
```

For each flagged clip it tries (a) the other voice, then (b) explicit `<phoneme>` tags for the whole word (every syllable for words; every readable token for sentences) with the original voice, then (c) explicit tags with the other voice. A clip that passes the automatic check is `auto_ok` again (retest it on the review page); if none pass it stays out as `suspect`. Rewrites of `data/build/audio-review.md` include flags, suspects and skipped sentences.

## Fixing suspect clips (Phase 35)

`--fix-suspect` runs the same three attempts as `--only-flagged` (other voice, then explicit per-syllable MOE readings with the original voice, then both) on every clip whose status is `suspect`. Each attempt is a new clip plus the speech-to-text check.

- The first attempt that passes replaces the clip: `auto_ok`, `fixed: true`, `fixedBy` names the attempt.
- If none passes, the **current clip and status stay exactly as they were** (suspect clips still play, so a failed fix never makes things worse). The entry gets `fixTried: <date>` and what each attempt was heard as. A later `--fix-suspect` skips it so reruns don't re-bill; `--fix-suspect --again` retries those.
- Works with `--max-chars=N` (stops cleanly, every finished fix saved), `--dry-run` (how many suspects would be tried and the most characters that could be billed) and `--levels`.
- The run ends with `fixed X of Y suspects, Z still suspect`; `data/build/audio-review.md` lists suspects still suspect (with what each attempt was heard as) and "Suspects fixed by --fix-suspect" (with the attempt that worked).

`--retry-suspect` is different: a plain re-roll with the **same voice and SSML**, so Azure usually returns the same audio. Prefer `--fix-suspect`.

### The owner's run (on the owner's computer, key in `packages/data-pipeline/.env`)

```
pnpm --filter @anan/data-pipeline audio:build --dry-run                 # what it would do
pnpm --filter @anan/data-pipeline audio:build                           # new words incl. textbook extras at any level
pnpm --filter @anan/data-pipeline audio:build --fix-suspect --dry-run   # how many suspects, max characters
pnpm --filter @anan/data-pipeline audio:build --fix-suspect             # 3 tries for each suspect
```

Then commit `data/build/audio` (mp3s plus `manifest.json`) and `data/build/audio-review.md`, and push; the push deploys the clips. Azure's free tier is 500,000 characters a month and every run prints its usage.

## In the app

Speaker buttons: word popover, review cards (after reveal), cloze feedback (the sentence if it has a clip, and the word), reader sentences. Normal and slow (0.75×, the audio element's `playbackRate`). **Nothing autoplays.** Chat replies have no audio unless that exact sentence text has a clip. Clips are cached by the service worker on first play (`?v=<hash>` busts the cache for regenerated clips) and work offline. Profile setting: Credits page → Audio → "Show speaker buttons".

## Known data note

The lexicon currently gives 和 as `ㄏㄜˊ` (hé). The brief's MOE example is hàn for 和 as "and". Audio follows the lexicon so it always matches the screen; fix the lexicon reading (not the audio) if hàn is wanted.

## Phase 15 — Listening practice

Listening is a third skill (`listening`) with its own FSRS card per item, created once the item's
recognition card reaches `review` and it has a usable clip. It never counts toward Phase 14
mastery and is excluded from plain review/cloze due lists, `knownSet` and forecasts.

- **Clips:** only `verified`/`auto_ok`; tone check and tone pairs use `verified` only (`listeningClip`).
- **Evidence:** `listening_correct` (Good), `listening_correct_replayed` (Hard; replays and the 0.75× slow play count), `listening_wrong` (Again). "Sounds wrong" removes the clip and skips with no evidence.
- **Exercises:** hear & pick, hear & type (tones required; a wrong tone is Hard-level), tone check (no 一/不, no 3+3), tone pairs, sentence dictation (per-word grading, ≤12 chars at Novice), listen & understand. Harder types unlock as stability grows (`LISTENING_CONFIG.unlock`).
- **Where:** Review → "Listen session"; ~20% mixed into review and cloze sessions; "Study this lesson" gets a listening round; lesson cards show listening stats separately.
- **Settings:** Credits → Audio → Listening practice (default on when audio is on). E2E: `localStorage anan.listening.disabled=1`.
- Nothing ever autoplays; a Listen session works offline once clips are cached (`prefetchClips`).
- Sentence clips and verified marks are currently absent, so sentence dictation, listen & understand, tone check and tone pairs appear only once such clips exist.
