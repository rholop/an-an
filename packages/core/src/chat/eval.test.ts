import { describe, expect, it } from 'vitest';
import { CHAT_EVAL_SCRIPT, dryChatEvalModels, renderChatEvalReport, runChatEval, summarizeChatEval } from './eval.js';

describe('chat eval (Phase 36 Part E.3)', () => {
  it('has 20 scripted turns with typos and gaps', () => {
    const turns = CHAT_EVAL_SCRIPT.flatMap((c) => c.turns);
    expect(turns).toHaveLength(20);
    expect(turns.filter((t) => t.typo).length).toBeGreaterThanOrEqual(3);
    expect(turns.filter((t) => t.gap).length).toBeGreaterThanOrEqual(2);
    for (const t of turns) if (t.typo) expect(t.zh).toContain(t.typo.wrong);
  });

  it('runs both modes on the dry stand-ins and writes a report', async () => {
    const results = await runChatEval(dryChatEvalModels());
    expect(results).toHaveLength(40);
    const s = summarizeChatEval(results.filter((r) => r.mode === 'open'));
    expect(s).toMatchObject({ turns: 20, contradicted: 0, typosFixed: s.typoTurns, precision: 1 });
    const md = renderChatEvalReport(results, { source: 'dry', date: '2026-10-10' });
    expect(md).toContain('## Scenario chat');
    expect(md).toContain('## Open chat');
  });

  it('counts a reply that says the opposite of what the learner said', async () => {
    const dry = dryChatEvalModels();
    const results = await runChatEval(
      {
        ...dry,
        async reply(mode, conv, history, extra) {
          const r = await dry.reply(mode, conv, history, extra);
          return history.length === 1 && conv.id === 'family'
            ? { ...r, reply_en: 'Your mom works at a school too.' }
            : r;
        },
      },
      { modes: ['scenario'] },
    );
    expect(results[0]!.contradicted).toBe(true);
    expect(summarizeChatEval(results).contradicted).toBe(1);
  });
});
