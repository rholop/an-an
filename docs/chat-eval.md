# Chat eval (Phase 36)

Run: 2026-10-10 · source: DRY RUN, offline stand-ins (NOT model output)

Re-run with `pnpm eval:chat` against a live proxy (`--dry` for the offline harness check). Acceptance:
facts contradicted in at most 1 of 20 turns per mode.

## Scenario chat

- Replies contradicting a stated fact: **0 of 20** (meets the bar)
- Shown with "may have misunderstood you": 0
- Typos fixed: 4 of 4; corrector precision 100% (4 corrections in all)

| # | Learner | Reply | Read as | Corrections | Verdict |
|---|---|---|---|---|---|
| 1 | 我爸爸在學校工作含我媽媽不工作。 | 真的嗎？然後呢？ | father: works at a school; mother: doesn't work | 含→和 | ok · typo fixed |
| 2 | 我爸爸每天很忙。我媽媽喜歡【gardening】。 | 真的嗎？然後呢？ | father: busy every day; mother: likes gardening | ✓ | ok |
| 3 | 她每天在家種花。 | 真的嗎？然後呢？ | mother: grows flowers at home every day | ✓ | ok |
| 4 | 我哥哥是醫生，他在台北工做。 | 真的嗎？然後呢？ | older brother: is a doctor; older brother: works in Taipei | 工做→工作 | ok · typo fixed |
| 5 | 我沒有姐姐。 | 真的嗎？然後呢？ | me: doesn't have an older sister | ✓ | ok |
| 6 | 我弟弟還是學生，他十六歲。 | 真的嗎？然後呢？ | younger brother: is a student; younger brother: is 16 | ✓ | ok |
| 7 | 我的家人都很喜歡喝茶。 | 真的嗎？然後呢？ | me: my family all like tea | ✓ | ok |
| 8 | 我週末常常去【hiking】。 | 真的嗎？然後呢？ | me: often goes hiking on weekends | ✓ | ok |
| 9 | 我不喜歡吃辣的。 | 真的嗎？然後呢？ | me: doesn't like spicy food | ✓ | ok |
| 10 | 昨天我跟朋友去吃牛肉麵，很好吃。 | 真的嗎？然後呢？ | me: ate beef noodles with a friend yesterday | ✓ | ok |
| 11 | 我住在台中，不住在台北。 | 真的嗎？然後呢？ | me: lives in Taichung; me: doesn't live in Taipei | ✓ | ok |
| 12 | 我的朋友叫小明，他是工程師。 | 真的嗎？然後呢？ | friend: is called 小明; friend: is an engineer | ✓ | ok |
| 13 | 我在學中文，因為我先生是台灣人。 | 真的嗎？然後呢？ | me: is learning Chinese; husband: is Taiwanese | ✓ | ok |
| 14 | 我很喜歡喝咖啡，可是我先生不喝咖啡。 | 真的嗎？然後呢？ | me: likes coffee; husband: doesn't drink coffee | ✓ | ok |
| 15 | 我明天要去買東西，你要不要一起去？ | 真的嗎？然後呢？ | me: is going shopping tomorrow | ✓ | ok |
| 16 | 我今天很累，因為我昨天睡的很晚。 | 真的嗎？然後呢？ | me: is tired today; me: went to bed late yesterday | 的→得 | ok · typo fixed |
| 17 | 我在便利商店買了一瓶水。 | 真的嗎？然後呢？ | me: bought a bottle of water at a convenience store | ✓ | ok |
| 18 | 我的老師中文說得很好，她教了十年了。 | 真的嗎？然後呢？ | teacher: has taught for ten years | ✓ | ok |
| 19 | 我想要學作菜。 | 真的嗎？然後呢？ | me: wants to learn to cook | 作菜→做菜 | ok · typo fixed |
| 20 | 我的狗很可愛，牠喜歡在公園跑步。 | 真的嗎？然後呢？ | dog: likes running in the park | ✓ | ok |

## Open chat

- Replies contradicting a stated fact: **0 of 20** (meets the bar)
- Shown with "may have misunderstood you": 0
- Typos fixed: 4 of 4; corrector precision 100% (4 corrections in all)

| # | Learner | Reply | Read as | Corrections | Verdict |
|---|---|---|---|---|---|
| 1 | 我爸爸在學校工作含我媽媽不工作。 | 真的嗎？然後呢？ | father: works at a school; mother: doesn't work | 含→和 | ok · typo fixed |
| 2 | 我爸爸每天很忙。我媽媽喜歡【gardening】。 | 真的嗎？然後呢？ | father: busy every day; mother: likes gardening | ✓ | ok |
| 3 | 她每天在家種花。 | 真的嗎？然後呢？ | mother: grows flowers at home every day | ✓ | ok |
| 4 | 我哥哥是醫生，他在台北工做。 | 真的嗎？然後呢？ | older brother: is a doctor; older brother: works in Taipei | 工做→工作 | ok · typo fixed |
| 5 | 我沒有姐姐。 | 真的嗎？然後呢？ | me: doesn't have an older sister | ✓ | ok |
| 6 | 我弟弟還是學生，他十六歲。 | 真的嗎？然後呢？ | younger brother: is a student; younger brother: is 16 | ✓ | ok |
| 7 | 我的家人都很喜歡喝茶。 | 真的嗎？然後呢？ | me: my family all like tea | ✓ | ok |
| 8 | 我週末常常去【hiking】。 | 真的嗎？然後呢？ | me: often goes hiking on weekends | ✓ | ok |
| 9 | 我不喜歡吃辣的。 | 真的嗎？然後呢？ | me: doesn't like spicy food | ✓ | ok |
| 10 | 昨天我跟朋友去吃牛肉麵，很好吃。 | 真的嗎？然後呢？ | me: ate beef noodles with a friend yesterday | ✓ | ok |
| 11 | 我住在台中，不住在台北。 | 真的嗎？然後呢？ | me: lives in Taichung; me: doesn't live in Taipei | ✓ | ok |
| 12 | 我的朋友叫小明，他是工程師。 | 真的嗎？然後呢？ | friend: is called 小明; friend: is an engineer | ✓ | ok |
| 13 | 我在學中文，因為我先生是台灣人。 | 真的嗎？然後呢？ | me: is learning Chinese; husband: is Taiwanese | ✓ | ok |
| 14 | 我很喜歡喝咖啡，可是我先生不喝咖啡。 | 真的嗎？然後呢？ | me: likes coffee; husband: doesn't drink coffee | ✓ | ok |
| 15 | 我明天要去買東西，你要不要一起去？ | 真的嗎？然後呢？ | me: is going shopping tomorrow | ✓ | ok |
| 16 | 我今天很累，因為我昨天睡的很晚。 | 真的嗎？然後呢？ | me: is tired today; me: went to bed late yesterday | 的→得 | ok · typo fixed |
| 17 | 我在便利商店買了一瓶水。 | 真的嗎？然後呢？ | me: bought a bottle of water at a convenience store | ✓ | ok |
| 18 | 我的老師中文說得很好，她教了十年了。 | 真的嗎？然後呢？ | teacher: has taught for ten years | ✓ | ok |
| 19 | 我想要學作菜。 | 真的嗎？然後呢？ | me: wants to learn to cook | 作菜→做菜 | ok · typo fixed |
| 20 | 我的狗很可愛，牠喜歡在公園跑步。 | 真的嗎？然後呢？ | dog: likes running in the park | ✓ | ok |

## Model chain decision

Kept the Phase 33 turn chain unchanged: this report is a dry run, so it shows no model doing better. Run `pnpm eval:chat` live (and `--model <name>` per candidate) and change `GEMINI_CHAIN_TURN` only if another free-tier model contradicts the learner less often.
