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
pnpm --filter @anan/data-pipeline audio:build                 # N1–L2 words + their sentences
pnpm --filter @anan/data-pipeline audio:build --levels=L3     # more later
```

- Output: `data/build/audio/words/{wordId}.mp3`, `sentences/{sentenceId}.mp3` (mono, 48 kbps) and `manifest.json` (id → file, voice, SSML hash, status, text).
- **Words** are synthesized alone, wrapped in `<phoneme alphabet="sapi">` with the lexicon's MOE zhuyin (neutral-tone `˙` moved after the syllable, which is how Azure writes it).
- **Sentences** are spoken naturally. Only *heteronym* tokens (還 長 行 得 了 重 著 為 調 樂 覺 和 … and any token whose lexicon readings differ) are wrapped, with the reading `resolveReading` chose, and **only when its confidence is `high`**. Otherwise the sentence is skipped and listed in `data/build/audio-review.md`. (`--accept-medium` also accepts readings a context rule picked.) 不/一 tone changes are never forced.
- Inputs: the lexicon, `data/build/sentences.v1.<level>.json`, and live sentences (phase 9) read from the newest saved copy of each profile in `apps/proxy/sync-data` (`--sync-dir=` to change).
- Idempotent/resumable: a clip is skipped when its SSML hash is unchanged. A rebuild with no changes makes zero Azure calls.
- Automatic check: each clip is run back through Azure speech-to-text (`zh-TW`); if the recognised characters differ from the text it is `suspect`. STT needs wav, so the clip is decoded with `ffmpeg` if installed; otherwise the same SSML is synthesized a second time as PCM (doubling characters).
- Statuses: `verified` (human OK), `auto_ok`, `suspect`, `flagged`. The app plays `verified` and `auto_ok` only (`playableClip` in core is the single gate).

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

## In the app

Speaker buttons: word popover, review cards (after reveal), cloze feedback (the sentence if it has a clip, and the word), reader sentences. Normal and slow (0.75×, the audio element's `playbackRate`). **Nothing autoplays.** Chat replies have no audio unless that exact sentence text has a clip. Clips are cached by the service worker on first play (`?v=<hash>` busts the cache for regenerated clips) and work offline. Profile setting: Credits page → Audio → "Show speaker buttons".

## Known data note

The lexicon currently gives 和 as `ㄏㄜˊ` (hé). The brief's MOE example is hàn for 和 as "and". Audio follows the lexicon so it always matches the screen; fix the lexicon reading (not the audio) if hàn is wanted.
