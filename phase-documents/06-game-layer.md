# Phase 6 brief: Game layer

> Paste into Claude Code with `CLAUDE.md` at the repo root. Phases 1–5 must be merged.

## Goal

Make the study loop feel like a game by rewarding learning behaviours, not time spent. Text and visuals only; no audio.

## Scope

1. **Rewards for learning behaviours only**: successful recalls, completing a scenario unassisted, journal entries, reviving an overdue word, fixing an error-bank item, self-corrections. Define these in one config table with point values. No points for time in app.
2. **Word garden / map**: a visual where each item is a plant (or tile) whose growth reflects state (introduced → mature) and which **wilts** as retrievability drops (FSRS `R(t)`). Tap a wilting area → a focused review of those words. Group by scenario/topic so it doubles as a map.
3. **Scenario progression**: scenario map by level; scenarios unlock from the frontier (Phase 2), and each has a star rating: completed, completed without "I'm stuck", completed with no English fallback. Add 3–5 more scenarios (convenience store, night market, asking a landlord about the deposit, calling a clinic, riding a YouBike) as data files.
4. **Real-world progress**: "you can handle ~X% of the words in everyday café conversations", computed by coverage of the learner's known set over each scenario's vocab + sentence corpus.
5. **Gentle streaks**: optional, off by default; freeze days allowed; never punish. A weekly summary instead of a daily nag.
6. **Metrics screen** (from the overview's evaluation plan): actual vs. target retention, journal errors per 100 chars trend, scenario completion without help, time to complete a scenario.

## Non-goals
- No audio of any kind (the game is text-only).
- No leaderboards, social features or monetization.
- No achievements for raw usage.

## Acceptance criteria

- Garden visibly wilts for items whose retrievability falls below the target retention, using a unit-tested mapping from FSRS state.
- Point table is data-driven and has no entry that rewards time or opens alone.
- Scenario coverage % matches `analyzeText` results on the scenario corpus (test).
- Everything works offline except live chat and journal review.

## Dependencies

Phase 2 FSRS state and retrievability; Phase 3 scenarios; Phase 4 session builder; Phase 5 error bank and journal events.
