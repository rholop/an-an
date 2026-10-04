## What changed

- **Navigation:** below 640px the 13-button top strip is replaced by a bottom tab bar (Home = the garden, Chat, Review, Journal, More). More is a bottom sheet with Reader, Cloze, Progress, Textbook, Placement, Anki import, Audio review, Credits, Zhuyin test and the light/dark toggle. The header is the profile name (with the sync dot), and the level picker. Desktop keeps the top nav (it now wraps instead of running off the edge).
- **Safe areas / height:** `viewport-fit=cover`; header, tab bar and sheets pad with `env(safe-area-inset-*)`; full-height screens use `100dvh`.
- **No hover on a phone:** the word popover is a full-width bottom sheet (tap outside, swipe down, or × to close). In the hide-the-reading modes the first tap reveals the reading (and records the same `chat_hover_reading` a hover did), the second opens the definition (`chat_lookup_gloss`). A tap on a word whose reading is already shown records one lookup and no hover event.
- **Touch size:** every button, select, link, chip and word is at least 44×44px. Words keep a 44px-wide cell and never break across lines, so a word's reading can't separate from its characters. Checkboxes are tapped through their 44px-tall label.
- **Text size:** Chinese body text is at least 20px; pinyin/zhuyin annotations at least 10px (zhuyin was 9px); inputs are 16px so iOS doesn't zoom.
- **Keyboards:** the chat is a full-screen column sized from `visualViewport` (iOS only shrinks the *visual* viewport), so the input row and "I'm stuck" stay above the keyboard and the newest message stays in view. Journal Submit and the cloze answer row are pinned above the keyboard. Typed answers use `lang=zh-Hant-TW`, no auto-capitalise / auto-correct / spellcheck, and a "done" key. Household code: big Continue button, `autocomplete=off`.
- **Screens:** suggested replies are one scrolling row; review grade buttons are one row of four at the bottom; the journal editor fills the screen and each highlighted part opens its correction in a bottom sheet; "New sentence" is a large bottom button; tables become stacked cards.
- **Installable:** manifest (`standalone`, portrait, 192/512/maskable icons, `start_url`/`scope` = `/an-an/`), Apple touch icon, iPhone web-app meta tags, theme colour for light and dark.
- **Speed:** each screen is its own JS chunk; the lexicon starts downloading immediately (preload) and is parsed once per visit instead of once per navigation; the first screen waits at most 1.5s for the server sync (it used to wait without limit).

## Load time

Measured with `apps/web/scripts/measure-load.mjs`: production build served with Brotli (as holop.dev's Cloudflare does), Chrome "Fast 4G" (9 Mbps, 170 ms), cold cache, 390×844 touch device.

| Screen with real content | normal CPU | 4× slower CPU |
| --- | --- | --- |
| Home (garden) | ≈ 2.5 s | ≈ 3.2 s |
| Chat scenarios | – | ≈ 3.2 s |
| Review | – | ≈ 3.1 s |

First paint (tab bar and a reserved-height placeholder) is at about 0.6 s. The time is dominated by the lexicon: 18 MB of JSON, ≈ 2.1 MB over the wire with Brotli. A current iPhone is much closer to the "normal CPU" column than to the 4× slowdown. If it ever needs to be faster, the next lever is splitting per-word detail (senses, Chinese definitions: ≈ 0.8 MB gzipped) out of the first download; that changes the data pipeline, so it was left alone.

## Manual checks (need a real iPhone)

The automated suite runs in real WebKit (Playwright's Linux WPE build: Safari's layout engine, not iOS itself). These cannot be simulated; please check on an iPhone in **both Safari and Chrome**, and tick them off here:

- [ ] Chat: tap the input — the keyboard opens, the input and "I'm stuck" stay visible above it, the latest message is in view. Close the keyboard — the layout returns to normal.
- [ ] Journal: tap the entry box — Submit stays reachable above the keyboard; typing Chinese does not auto-capitalise or auto-correct.
- [ ] Cloze (a typed-answer item): the keyboard has a "done" key and no auto-correct.
- [ ] Tap a word in the Reader — the sheet appears at the bottom, within the screen; swipe down closes it; tapping the page closes it.
- [ ] Zhuyin and pinyin screenshots (`after/…/light-reader-zhuyin.jpg`, `…-both.jpg`) look the same on the device: no overlap, no wrapping apart from the character.
- [ ] Add to Home Screen from Safari: the icon is the green sprout, it opens full-screen, the status bar is readable in light and dark, and it opens to the app under `/an-an/`.
- [ ] Rotate to landscape: nothing is cut off (landscape was not part of this phase's design).

## Running the audit

```sh
# screenshots + findings for every route, light and dark, on both iPhones
MOBILE_AUDIT=after pnpm --filter @anan/web exec playwright test e2e/mobile/audit.spec.ts
node apps/web/scripts/mobile-audit-report.mjs      # rewrites this file
# the acceptance suite (also runs in CI)
pnpm --filter @anan/web exec playwright test e2e/mobile/mobile.spec.ts
```

The `before/` set was taken at the start of the phase, on the unchanged app, and converted to phone-width JPEGs to keep the repository small. WebKit needs `playwright install webkit`; on a Linux machine without the system libraries (this one, an immutable Fedora) the missing libraries were unpacked into Playwright's `webkit-*/minibrowser-wpe/sys/lib` folder instead of installing packages — CI uses `--with-deps`.
