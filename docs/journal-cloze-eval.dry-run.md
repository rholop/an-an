# Journal cloze eval

Generated 2026-10-05T22:50:52.247Z against an offline dry run (NOT model output) (prompts v1).

Baseline for prompt changes (phase doc 17 Part F). Read every block and replace each `_pending_`
with **✅ good**, **⚠️ acceptable but could be better**, or **❌ wrong** (a wrong sentence shown,
or a correct fix rejected). Ship only when no item is ❌.

## Summary

- sentences: 47 (verified 46, rejected 0, errors 1)
- items built: 37
- hard-rule violations found by the harness: **0** (must be 0)

## example-garbled (owner-example)

- You wrote: 我的姓印名字印羅恩。
- Reference (human): 我姓印，名字叫羅恩。 — My surname is Yin and my name is Rowan.
- Note: The sentence from the owner's screenshot (fixtures/17-garbled-cloze-example.png). 我的姓是印，名字是羅恩。 is also acceptable.
- Model corrected: 我姓印，名字叫羅恩。
- Check: **verified** → 我姓印，名字叫羅恩。 (My surname is Yin and my name is Rowan.)
- Edits: `的`→`∅` particle (from diff); `∅`→`，` missing_word (from diff); `印`→`叫` wrong_word (from diff)
- Item **extra_word** — “One word here doesn't belong. Tap it.” → 我的姓印名字印羅恩。
  - answer: 的; accepted: —
  - Verdict: _pending_
- Item **cloze** — “Use the right word here.” → 我姓印，名字＿＿＿＿羅恩。
  - answer: 叫; accepted: 叫; solver: 叫 (confident)
  - Verdict: _pending_

## missing-shi-1 (missing-是)

- You wrote: 他老師。
- Reference (human): 他是老師。 — He is a teacher.
- Model corrected: 他是老師。
- Check: **verified** → 他是老師。 (He is a teacher.)
- Edits: `∅`→`是` missing_word (from diff)
- Item **cloze** — “A word is missing here.” → 他＿＿＿＿老師。
  - answer: 是; accepted: 是; solver: 是 (confident)
  - Verdict: _pending_

## missing-shi-2 (missing-是)

- You wrote: 我的朋友台灣人。
- Reference (human): 我的朋友是台灣人。 — My friend is Taiwanese.
- Model corrected: 我的朋友是台灣人。
- Check: **verified** → 我的朋友是台灣人。 (My friend is Taiwanese.)
- Edits: `∅`→`是` missing_word (from diff)
- Item **cloze** — “A word is missing here.” → 我的朋友＿＿＿＿台灣人。
  - answer: 是; accepted: 是; solver: 是 (confident)
  - Verdict: _pending_

## missing-shi-3 (missing-是)

- You wrote: 這我的書。
- Reference (human): 這是我的書。 — This is my book.
- Model corrected: 這是我的書。
- Check: **verified** → 這是我的書。 (This is my book.)
- Edits: `∅`→`是` missing_word (from diff)
- Item **cloze** — “A word is missing here.” → 這＿＿＿＿我的書。
  - answer: 是; accepted: 是; solver: 是 (confident)
  - Verdict: _pending_

## missing-shi-4 (missing-是)

- You wrote: 我哥哥學生。
- Reference (human): 我哥哥是學生。 — My older brother is a student.
- Model corrected: 我哥哥是學生。
- Check: **verified** → 我哥哥是學生。 (My older brother is a student.)
- Edits: `∅`→`是` missing_word (from diff)
- Item **cloze** — “A word is missing here.” → 我哥哥＿＿＿＿學生。
  - answer: 是; accepted: 是; solver: 是 (confident)
  - Verdict: _pending_

## missing-de-1 (missing-的)

- You wrote: 這是我老師書。
- Reference (human): 這是我老師的書。 — This is my teacher's book.
- Model corrected: 這是我老師的書。
- Check: **verified** → 這是我老師的書。 (This is my teacher's book.)
- Edits: `∅`→`的` particle (from diff)
- Item **cloze** — “A small word (a particle) is missing here.” → 這是我老師＿＿＿＿書。
  - answer: 的; accepted: 的; solver: 的 (confident)
  - Verdict: _pending_

## missing-de-2 (missing-的)

- You wrote: 我喜歡他給我禮物。
- Reference (human): 我喜歡他給我的禮物。 — I like the gift he gave me.
- Model corrected: 我喜歡他給我的禮物。
- Check: **verified** → 我喜歡他給我的禮物。 (I like the gift he gave me.)
- Edits: `∅`→`的` particle (from diff)
- Item **cloze** — “A small word (a particle) is missing here.” → 我喜歡他給我＿＿＿＿禮物。
  - answer: 的; accepted: 的; solver: 的 (confident)
  - Verdict: _pending_

## missing-de-3 (missing-的)

- You wrote: 這是很好咖啡。
- Reference (human): 這是很好的咖啡。 — This is very good coffee.
- Model corrected: 這是很好的咖啡。
- Check: **verified** → 這是很好的咖啡。 (This is very good coffee.)
- Edits: `好`→`好的` wrong_word (from diff)
- Item **cloze** — “Use the right word here.” → 這是很＿＿＿＿咖啡。
  - answer: 好的; accepted: 好的; solver: 好的 (confident)
  - Verdict: _pending_

## missing-le-1 (missing-了)

- You wrote: 我昨天買一本書。
- Reference (human): 我昨天買了一本書。 — I bought a book yesterday.
- Model corrected: 我昨天買了一本書。
- Check: **verified** → 我昨天買了一本書。 (I bought a book yesterday.)
- Edits: `∅`→`了` particle (from diff)
- Item **cloze** — “A small word (a particle) is missing here.” → 我昨天買＿＿＿＿一本書。
  - answer: 了; accepted: 了; solver: 了 (confident)
  - Verdict: _pending_

## missing-le-2 (missing-了)

- You wrote: 他已經走。
- Reference (human): 他已經走了。 — He has already left.
- Model corrected: 他已經走了。
- Check: **verified** → 他已經走了。 (He has already left.)
- Edits: `∅`→`了` particle (from diff)
- Item **cloze** — “A small word (a particle) is missing here.” → 他已經走＿＿＿＿。
  - answer: 了; accepted: 了; solver: 了 (confident)
  - Verdict: _pending_

## missing-le-3 (missing-了)

- You wrote: 我們昨天看電影。
- Reference (human): 我們昨天看了電影。 — We watched a movie yesterday.
- Model corrected: 我們昨天看了電影。
- Check: **verified** → 我們昨天看了電影。 (We watched a movie yesterday.)
- Edits: `∅`→`了` particle (from diff)
- Item **cloze** — “A small word (a particle) is missing here.” → 我們昨天看＿＿＿＿電影。
  - answer: 了; accepted: 了; solver: 了 (confident)
  - Verdict: _pending_

## measure-1 (measure-word)

- You wrote: 我有三個狗。
- Reference (human): 我有三隻狗。 — I have three dogs.
- Model corrected: 我有三隻狗。
- Check: **verified** → 我有三隻狗。 (I have three dogs.)
- Edits: `個`→`隻` wrong_word (from diff)
- Item **cloze** — “Use the right word here.” → 我有三＿＿＿＿狗。
  - answer: 隻; accepted: 隻; solver: 隻 (confident)
  - Verdict: _pending_

## measure-2 (measure-word)

- You wrote: 我買了兩個書。
- Reference (human): 我買了兩本書。 — I bought two books.
- Model corrected: 我買了兩本書。
- Check: **verified** → 我買了兩本書。 (I bought two books.)
- Edits: `個`→`本` wrong_word (from diff)
- Item **cloze** — “Use the right word here.” → 我買了兩＿＿＿＿書。
  - answer: 本; accepted: 本; solver: 本 (confident)
  - Verdict: _pending_

## measure-3 (measure-word)

- You wrote: 我有一個桌子。
- Reference (human): 我有一張桌子。 — I have a table.
- Model corrected: 我有一張桌子。
- Check: **verified** → 我有一張桌子。 (I have a table.)
- Edits: `一個`→`一張` wrong_word (from diff)
- Dropped (e0): e0: blank would cover a number

## measure-4 (measure-word)

- You wrote: 他騎一個機車。
- Reference (human): 他騎一台機車。 — He rides a scooter.
- Model corrected: 他騎一台機車。
- Check: **verified** → 他騎一台機車。 (He rides a scooter.)
- Edits: `一個`→`一台` wrong_word (from diff)
- Dropped (e0): e0: blank would cover a number

## measure-5 (measure-word)

- You wrote: 我要一個咖啡。
- Reference (human): 我要一杯咖啡。 — I'd like a coffee.
- Model corrected: 我要一杯咖啡。
- Check: **verified** → 我要一杯咖啡。 (I'd like a coffee.)
- Edits: `一個`→`一杯` wrong_word (from diff)
- Dropped (e0): e0: blank would cover a number

## order-1 (word-order)

- You wrote: 我去昨天夜市。
- Reference (human): 我昨天去夜市。 — I went to the night market yesterday.
- Model corrected: 我昨天去夜市。
- Check: **verified** → 我昨天去夜市。 (I went to the night market yesterday.)
- Edits: `去`→`∅` word_order (from diff); `∅`→`去` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 我 / 昨天 / 去 / 夜市。
  - answer: 我昨天去夜市。; accepted: 我昨天去夜市。
  - Verdict: _pending_

## order-2 (word-order)

- You wrote: 我很喜歡咖啡喝。
- Reference (human): 我很喜歡喝咖啡。 — I really like drinking coffee.
- Model corrected: 我很喜歡喝咖啡。
- Check: **verified** → 我很喜歡喝咖啡。 (I really like drinking coffee.)
- Edits: `咖啡`→`∅` word_order (from diff); `∅`→`咖啡` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 我 / 很 / 喜歡 / 喝 / 咖啡。
  - answer: 我很喜歡喝咖啡。; accepted: 我很喜歡喝咖啡。
  - Verdict: _pending_

## order-3 (word-order)

- You wrote: 他在台北住。
- Reference (human): 他住在台北。 — He lives in Taipei.
- Model corrected: 他住在台北。
- Check: **verified** → 他住在台北。 (He lives in Taipei.)
- Edits: `在`→`住在` word_order (from diff); `住`→`∅` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 他 / 住在 / 台北。
  - answer: 他住在台北。; accepted: 他住在台北。
  - Verdict: _pending_

## order-4 (word-order)

- You wrote: 我們吃飯在家。
- Reference (human): 我們在家吃飯。 — We eat at home.
- Model corrected: 我們在家吃飯。
- Check: **verified** → 我們在家吃飯。 (We eat at home.)
- Edits: `吃飯`→`∅` word_order (from diff); `∅`→`吃飯` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 我們 / 在家 / 吃飯。
  - answer: 我們在家吃飯。; accepted: 我們在家吃飯。
  - Verdict: _pending_

## order-5 (word-order)

- You wrote: 你有沒有時間明天？
- Reference (human): 你明天有沒有時間？ — Do you have time tomorrow?
- Model corrected: 你明天有沒有時間？
- Check: **verified** → 你明天有沒有時間？ (Do you have time tomorrow?)
- Edits: `∅`→`明天` word_order (from diff); `明天`→`∅` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 你 / 明天 / 有 / 沒有 / 時間？
  - answer: 你明天有沒有時間？; accepted: 你明天有沒有時間？
  - Verdict: _pending_

## mainland-1 (mainland-word)

- You wrote: 我坐地鐵去上班。
- Reference (human): 我搭捷運去上班。 — I take the MRT to work.
- Model corrected: 我搭捷運去上班。
- Check: **verified** → 我搭捷運去上班。 (I take the MRT to work.)
- Edits: `坐地鐵`→`搭捷運` mainland_style (from diff)
- Item **choice** — “Pick the Taiwan word.” → 我＿＿＿＿去上班。
  - answer: 搭捷運; accepted: 搭捷運; options: 坐地鐵 / 搭捷運
  - Verdict: _pending_

## mainland-2 (mainland-word)

- You wrote: 我用視頻跟媽媽聊天。
- Reference (human): 我用視訊跟媽媽聊天。 — I video-chat with my mom.
- **Error:** Error: dry run: no retry

## mainland-3 (mainland-word)

- You wrote: 這個軟件很好用。
- Reference (human): 這個軟體很好用。 — This software is easy to use.
- Model corrected: 這個軟體很好用。
- Check: **verified** → 這個軟體很好用。 (This software is easy to use.)
- Edits: `軟件`→`軟體` wrong_word (from diff)
- Item **cloze** — “Use the right word here.” → 這個＿＿＿＿很好用。
  - answer: 軟體; accepted: 軟體; solver: 軟體 (confident)
  - Verdict: _pending_

## mainland-4 (mainland-word)

- You wrote: 我在網絡上買東西。
- Reference (human): 我在網路上買東西。 — I buy things online.
- Model corrected: 我在網路上買東西。
- Check: **verified** → 我在網路上買東西。 (I buy things online.)
- Edits: `網絡`→`網路` wrong_word (from diff)
- Item **cloze** — “Use the right word here.” → 我在＿＿＿＿上買東西。
  - answer: 網路; accepted: 網路; solver: 網路 (confident)
  - Verdict: _pending_

## mainland-5 (mainland-word)

- You wrote: 我想吃土豆。
- Reference (human): 我想吃馬鈴薯。 — I want to eat potatoes.
- Model corrected: 我想吃馬鈴薯。
- Check: **verified** → 我想吃馬鈴薯。 (I want to eat potatoes.)
- Edits: `吃土豆`→`吃馬鈴薯` mainland_style (from diff)
- Item **choice** — “Pick the Taiwan word.” → 我想＿＿＿＿。
  - answer: 吃馬鈴薯; accepted: 吃馬鈴薯; options: 吃土豆 / 吃馬鈴薯
  - Verdict: _pending_

## mainland-6 (mainland-word)

- You wrote: 我有一個自行車。
- Reference (human): 我有一台腳踏車。 — I have a bicycle.
- Model corrected: 我有一台腳踏車。
- Check: **verified** → 我有一台腳踏車。 (I have a bicycle.)
- Edits: `一個自行車`→`一台腳踏車` mainland_style (from diff)
- Item **fix** — “Rewrite this sentence so it is correct.” → 我有一個自行車。
  - answer: 我有一台腳踏車。; accepted: 我有一台腳踏車。
  - Verdict: _pending_

## name-1 (names)

- You wrote: 羅恩今天去台灣。
- Reference (human): 羅恩今天去台灣。 — Rowan is going to Taiwan today.
- Note: already correct; contains a name
- Model corrected: 羅恩今天去台灣。
- Check: **verified** → 羅恩今天去台灣。 (Rowan is going to Taiwan today.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## name-2 (names)

- You wrote: 小安喜歡咖啡很多。
- Reference (human): 小安很喜歡咖啡。 — Xiao An likes coffee a lot.
- Model corrected: 小安很喜歡咖啡。
- Check: **verified** → 小安很喜歡咖啡。 (Xiao An likes coffee a lot.)
- Edits: `∅`→`很` missing_word (from diff); `很多`→`∅` extra_word (from diff)
- Item **cloze** — “A word is missing here.” → 小安＿＿＿＿喜歡咖啡。
  - answer: 很; accepted: 很; solver: 很 (confident)
  - Verdict: _pending_
- Dropped (e1): e1: the extra text is not a single plain word

## name-3 (names)

- You wrote: 我跟冠宇去夜市了昨天。
- Reference (human): 我昨天跟冠宇去了夜市。 — Yesterday I went to the night market with Guanyu.
- Model corrected: 我昨天跟冠宇去了夜市。
- Check: **verified** → 我昨天跟冠宇去了夜市。 (Yesterday I went to the night market with Guanyu.)
- Edits: `∅`→`昨天` word_order (from diff); `夜市`→`∅` word_order (from diff); `昨天`→`夜市` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 我 / 昨天 / 跟 / 冠 / 宇 / 去 / 了 / 夜市。
  - answer: 我昨天跟冠宇去了夜市。; accepted: 我昨天跟冠宇去了夜市。
  - Verdict: _pending_

## name-4 (names)

- You wrote: 我是從美國來。
- Reference (human): 我從美國來。 — I come from America.
- Model corrected: 我從美國來。
- Check: **verified** → 我從美國來。 (I come from America.)
- Edits: `是`→`∅` extra_word (from diff)
- Item **extra_word** — “One word here doesn't belong. Tap it.” → 我是從美國來。
  - answer: 是; accepted: —
  - Verdict: _pending_

## number-1 (numbers)

- You wrote: 我有三個姊姊。
- Reference (human): 我有三個姊姊。 — I have three older sisters.
- Note: already correct; contains a number
- Model corrected: 我有三個姊姊。
- Check: **verified** → 我有三個姊姊。 (I have three older sisters.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## number-2 (numbers)

- You wrote: 我今年二十五歲了。
- Reference (human): 我今年二十五歲了。 — I am twenty-five this year.
- Note: already correct; contains a number
- Model corrected: 我今年二十五歲了。
- Check: **verified** → 我今年二十五歲了。 (I am twenty-five this year.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## number-3 (numbers)

- You wrote: 我買了二個蘋果。
- Reference (human): 我買了兩個蘋果。 — I bought two apples.
- Note: the changed word is a number: it must never be a blank
- Model corrected: 我買了兩個蘋果。
- Check: **verified** → 我買了兩個蘋果。 (I bought two apples.)
- Edits: `二`→`兩` wrong_word (from diff)
- Dropped (e0): e0: blank would cover a number

## number-4 (numbers)

- You wrote: 現在是下午三點鐘。
- Reference (human): 現在是下午三點鐘。 — It is three o'clock in the afternoon.
- Note: already correct; contains a number
- Model corrected: 現在是下午三點鐘。
- Check: **verified** → 現在是下午三點鐘。 (It is three o'clock in the afternoon.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## multi-1 (multiple-errors)

- You wrote: 昨天我去夜市買東西很多。
- Reference (human): 昨天我去夜市買了很多東西。 — Yesterday I went to the night market and bought a lot of things.
- Model corrected: 昨天我去夜市買了很多東西。
- Check: **verified** → 昨天我去夜市買了很多東西。 (Yesterday I went to the night market and bought a lot of things.)
- Edits: `買東西`→`買了` wrong_word (from diff); `∅`→`東西` missing_word (from diff)
- Item **cloze** — “Use the right word here.” → 昨天我去夜市＿＿＿＿很多東西。
  - answer: 買了; accepted: 買了; solver: 買了 (confident)
  - Verdict: _pending_
- Item **cloze** — “A word is missing here.” → 昨天我去夜市買了很多＿＿＿＿。
  - answer: 東西; accepted: 東西; solver: 東西 (confident)
  - Verdict: _pending_

## multi-2 (multiple-errors)

- You wrote: 他不是喜歡咖啡。
- Reference (human): 他不喜歡咖啡。 — He doesn't like coffee.
- Model corrected: 他不喜歡咖啡。
- Check: **verified** → 他不喜歡咖啡。 (He doesn't like coffee.)
- Edits: `不是`→`不` wrong_word (from diff)
- Item **cloze** — “Use the right word here.” → 他＿＿＿＿喜歡咖啡。
  - answer: 不; accepted: 不; solver: 不 (confident)
  - Verdict: _pending_

## multi-3 (multiple-errors)

- You wrote: 我很高興見面你。
- Reference (human): 我很高興見到你。 — I'm happy to meet you.
- Model corrected: 我很高興見到你。
- Check: **verified** → 我很高興見到你。 (I'm happy to meet you.)
- Edits: `見面`→`見到` wrong_word (from diff)
- Item **cloze** — “Use the right word here.” → 我很高興＿＿＿＿你。
  - answer: 見到; accepted: 見到; solver: 見到 (confident)
  - Verdict: _pending_

## multi-4 (multiple-errors)

- You wrote: 我們一起去看電影昨天晚上。
- Reference (human): 我們昨天晚上一起去看電影。 — Last night we went to see a movie together.
- Model corrected: 我們昨天晚上一起去看電影。
- Check: **verified** → 我們昨天晚上一起去看電影。 (Last night we went to see a movie together.)
- Edits: `∅`→`昨天晚上` word_order (from diff); `昨天晚上`→`∅` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 我們 / 昨天 / 晚上 / 一起 / 去 / 看 / 電影。
  - answer: 我們昨天晚上一起去看電影。; accepted: 我們昨天晚上一起去看電影。
  - Verdict: _pending_

## multi-5 (multiple-errors)

- You wrote: 我有兩個朋友是台灣人，他們很好人。
- Reference (human): 我有兩個朋友是台灣人，他們人很好。 — I have two friends who are Taiwanese; they are very nice.
- Model corrected: 我有兩個朋友是台灣人，他們人很好。
- Check: **verified** → 我有兩個朋友是台灣人，他們人很好。 (I have two friends who are Taiwanese; they are very nice.)
- Edits: `∅`→`人` word_order (from diff); `好人`→`好` word_order (from diff)
- Item **fix** — “Rewrite this sentence so it is correct.” → 我有兩個朋友是台灣人，他們很好人。
  - answer: 我有兩個朋友是台灣人，他們人很好。; accepted: 我有兩個朋友是台灣人，他們人很好。
  - Verdict: _pending_

## multi-6 (multiple-errors)

- You wrote: 我昨天去夜市買三個東西喝咖啡。
- Reference (human): 我昨天去夜市買了三樣東西，還喝了咖啡。 — Yesterday I went to the night market, bought three things and had coffee.
- Note: larger rewrite: expect a Fix my sentence item
- Model corrected: 我昨天去夜市買了三樣東西，還喝了咖啡。
- Check: **verified** → 我昨天去夜市買了三樣東西，還喝了咖啡。 (Yesterday I went to the night market, bought three things and had coffee.)
- Edits: `∅`→`了` particle (from diff); `個`→`樣` wrong_word (from diff); `∅`→`，還` missing_word (from diff); `∅`→`了` particle (from diff)
- Item **cloze** — “A small word (a particle) is missing here.” → 我昨天去夜市買＿＿＿＿三樣東西，還喝了咖啡。
  - answer: 了; accepted: 了; solver: 了 (confident)
  - Verdict: _pending_
- Item **cloze** — “Use the right word here.” → 我昨天去夜市買了三＿＿＿＿東西，還喝了咖啡。
  - answer: 樣; accepted: 樣; solver: 樣 (confident)
  - Verdict: _pending_
- Item **cloze** — “A small word (a particle) is missing here.” → 我昨天去夜市買了三樣東西，還喝＿＿＿＿咖啡。
  - answer: 了; accepted: 了; solver: 了 (confident)
  - Verdict: _pending_
- Dropped (e2): e2: blank would cover punctuation or a number

## particle-1 (particle)

- You wrote: 你吃飯嗎了？
- Reference (human): 你吃飯了嗎？ — Have you eaten?
- Model corrected: 你吃飯了嗎？
- Check: **verified** → 你吃飯了嗎？ (Have you eaten?)
- Edits: `嗎`→`∅` word_order (from diff); `∅`→`嗎` word_order (from diff)
- Item **reorder** — “Put the words in the right order.” → 你 / 吃飯 / 了 / 嗎？
  - answer: 你吃飯了嗎？; accepted: 你吃飯了嗎？
  - Verdict: _pending_

## correct-1 (already-correct)

- You wrote: 我喜歡喝咖啡。
- Reference (human): 我喜歡喝咖啡。 — I like drinking coffee.
- Model corrected: 我喜歡喝咖啡。
- Check: **verified** → 我喜歡喝咖啡。 (I like drinking coffee.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## correct-2 (already-correct)

- You wrote: 今天天氣很好。
- Reference (human): 今天天氣很好。 — The weather is nice today.
- Model corrected: 今天天氣很好。
- Check: **verified** → 今天天氣很好。 (The weather is nice today.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## correct-3 (already-correct)

- You wrote: 我昨天去了夜市。
- Reference (human): 我昨天去了夜市。 — I went to the night market yesterday.
- Model corrected: 我昨天去了夜市。
- Check: **verified** → 我昨天去了夜市。 (I went to the night market yesterday.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## correct-4 (already-correct)

- You wrote: 他是我的老師。
- Reference (human): 他是我的老師。 — He is my teacher.
- Model corrected: 他是我的老師。
- Check: **verified** → 他是我的老師。 (He is my teacher.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_

## correct-5 (already-correct)

- You wrote: 我每天搭捷運去學校。
- Reference (human): 我每天搭捷運去學校。 — I take the MRT to school every day.
- Model corrected: 我每天搭捷運去學校。
- Check: **verified** → 我每天搭捷運去學校。 (I take the MRT to school every day.)
- Edits: _none (already correct)_
- _no items_ — verdict: _pending_
