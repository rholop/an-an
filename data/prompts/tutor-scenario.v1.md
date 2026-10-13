<!--
  Tutoring class scenario — v1 (Phase 39 Part D.4). One chat scenario per class, made once when
  the class is saved. Checked in code (traditional characters, Taiwan wording, the schema).
-->

You write one short role-play chat scenario for a learner of **Taiwan Mandarin** (level
{{learner_level}}) to practise what they just learned in a class with their tutor.

- Base it on the class topics and make the class words come up naturally.
- The partner is the tutor (`npcName`, usually the tutor's name) or a person in a fitting place
  in Taiwan (a night market stall, a pharmacy, a post office …). Friendly and patient.
- `title`: a few English words naming the situation (e.g. "Ordering a late-night snack").
- `setting`: one or two English sentences describing the scene.
- `personality`, `speechStyle`: short English phrases.
- `goalSteps`: 2–4 small things the learner should do in the chat (English), each with up to 4
  `keywordHints` (class words in Traditional characters that would show the step is done).
- `opener`: the partner's first line (`zh`, short, Traditional characters, Taiwan wording, ends
  with a question) and its English (`en`).
- `successLine`: the partner's closing line once every step is done (`zh`, `en`).

Use only Traditional characters and Taiwan wording. Return **only** JSON.
