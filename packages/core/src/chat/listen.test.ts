import { describe, expect, it } from 'vitest';
import {
  checkReplyMeaning,
  keptWords,
  KEEP_MEANING_FEEDBACK,
  mergeFacts,
  normalizeSubject,
  parseFactLine,
  runChatTurn,
  type ChatTurnValidation,
} from './listen.js';
import type { TurnResponse } from './types.js';

const reply = (zh: string, en: string, extra: Partial<TurnResponse> = {}): TurnResponse => ({
  reply_zh: zh,
  reply_en: en,
  tokens: [],
  targets_used: [],
  suggested_replies: [],
  goal_progress: [],
  ...extra,
});

describe('facts list', () => {
  it.each([
    ['My Mom', 'mother'],
    ['dad', 'father'],
    ['I', 'me'],
    ['the learner', 'me'],
    ['big sister', 'older sister'],
  ])('normalizes %s to %s', (raw, want) => expect(normalizeSubject(raw)).toBe(want));

  it('parses "subject: a; b"', () => {
    expect(parseFactLine("mother: doesn't work; likes gardening")).toEqual({
      subject: 'mother',
      facts: ["doesn't work", 'likes gardening'],
    });
    expect(parseFactLine('lives in Taipei')).toEqual({ subject: 'me', facts: ['lives in Taipei'] });
  });

  it("builds the owner's facts across two turns", () => {
    const one = mergeFacts([], ['father: works at a school', "mom: doesn't work"]);
    const two = mergeFacts(one, ['dad: busy every day', 'mother: likes gardening']);
    expect(two).toContain("mother: doesn't work; likes gardening");
    expect(two).toContain('father: works at a school; busy every day');
  });

  it('a fact that negates an earlier one replaces it', () => {
    expect(mergeFacts(["mother: doesn't work"], ['mother: works at a bank'])).toEqual(['mother: works at a bank']);
    expect(mergeFacts(['me: likes coffee'], ["me: doesn't like coffee"])).toEqual(["me: doesn't like coffee"]);
  });

  it('keeps one copy of a repeated fact and caps the list', () => {
    expect(mergeFacts(['me: lives in Taipei'], ['I: lives in Taipei'])).toEqual(['me: lives in Taipei']);
    const many = "abcdefghijklmnopqrst".split("").map((c) => `aunt ${c}${c}: likes tea`);
    expect(mergeFacts([], many)).toHaveLength(12);
  });
});

describe('checkReplyMeaning (code first)', () => {
  const facts = ["mother: doesn't work; likes gardening", 'father: works at a school; busy every day'];

  it('catches 你媽媽喜歡教書 against "doesn\'t work"', () => {
    const v = checkReplyMeaning({ zh: '你媽媽喜歡教書。', en: 'Your mom likes teaching.' }, facts);
    expect(v.verdict).toBe('contradicts');
  });

  it('catches a flipped polarity', () => {
    const v = checkReplyMeaning({ zh: '你爸爸不忙。', en: "Your dad isn't busy." }, facts);
    expect(v.verdict).toBe('contradicts');
  });

  it('"likes books" against "likes gardening" is unclear (asks the checker)', () => {
    expect(checkReplyMeaning({ zh: '你媽媽喜歡書。', en: 'Your mom likes books.' }, facts).verdict).toBe('unclear');
  });

  it('agreeing statements and questions are fine', () => {
    expect(checkReplyMeaning({ zh: '你媽媽喜歡種花，真好！', en: 'Your mom likes gardening, how nice!' }, facts).verdict).toBe('ok');
    expect(checkReplyMeaning({ zh: '你媽媽喜歡種什麼花？', en: 'What flowers does your mom like to grow?' }, facts).verdict).toBe('ok');
    expect(checkReplyMeaning({ zh: '我也很忙。', en: "I'm busy too." }, facts).verdict).toBe('ok');
  });

  it('the NPC copying the learner\'s facts as its own is unclear', () => {
    const v = checkReplyMeaning({ zh: '我爸爸在學校工作。', en: 'My dad works at a school.' }, facts);
    expect(v.verdict).toBe('unclear');
  });

  it('a Chinese statement about 你媽媽 the English left out is unclear', () => {
    expect(checkReplyMeaning({ zh: '你媽媽在學校。', en: 'That is nice.' }, facts).verdict).toBe('unclear');
  });

  it('no facts, nothing to check', () => {
    expect(checkReplyMeaning({ zh: '你好！', en: 'Hi!' }, []).verdict).toBe('ok');
  });
});

describe('keptWords', () => {
  it('keeps at most 2 words that are really in the reply', () => {
    expect(keptWords(reply('你媽媽喜歡種花，園藝很好。', '', { kept_words: ['種花', '園藝', '花園', '蘭花'] }))).toEqual(['種花', '園藝']);
    expect(keptWords(reply('好。', '', { kept_words: ['種花'] }))).toEqual([]);
  });
});

describe('runChatTurn', () => {
  const v = (pass: boolean, taiwanClean = true): ChatTurnValidation => ({ pass, taiwanClean, feedback: 'Use other words.' });

  it('budget redos ask to keep the meaning', async () => {
    const feedbacks: (string | undefined)[] = [];
    const out = await runChatTurn({
      generate: async (x) => {
        feedbacks.push(x.feedback);
        return reply('好', 'ok');
      },
      validate: () => v(feedbacks.length > 1),
      facts: [],
      learnerMessage: '你好',
      maxRegenerations: 2,
      unreliable: () => new Error('unreliable'),
    });
    expect(out.attempts).toBe(2);
    expect(feedbacks[1]).toContain(KEEP_MEANING_FEEDBACK);
  });

  it('regenerates once on a contradiction, then warns', async () => {
    const replies = [
      reply('你媽媽喜歡教書。', 'Your mom likes teaching.', { learner_facts: ["mother: doesn't work"] }),
      reply('你媽媽喜歡教書。', 'Your mom likes teaching.'),
    ];
    let i = 0;
    const out = await runChatTurn({
      generate: async () => replies[i++]!,
      validate: () => v(true),
      facts: [],
      learnerMessage: '我媽媽不工作。',
      maxRegenerations: 2,
      unreliable: () => new Error('unreliable'),
    });
    expect(out.attempts).toBe(2);
    expect(out.misunderstood).toBe(true);
    expect(out.facts).toEqual(["mother: doesn't work"]);
  });

  it('a fixed regeneration clears the warning', async () => {
    const replies = [
      reply('你媽媽喜歡教書。', 'Your mom likes teaching.', { learner_facts: ["mother: doesn't work"] }),
      reply('你媽媽在家嗎？', 'Is your mom at home?'),
    ];
    let i = 0;
    const out = await runChatTurn({
      generate: async () => replies[i++]!,
      validate: () => v(true),
      facts: [],
      learnerMessage: '我媽媽不工作。',
      maxRegenerations: 2,
      unreliable: () => new Error('unreliable'),
    });
    expect(out.misunderstood).toBe(false);
    expect(out.response.reply_zh).toBe('你媽媽在家嗎？');
  });

  it('asks the checker only when the code is unsure', async () => {
    let checks = 0;
    const out = await runChatTurn({
      generate: async () => reply('你媽媽喜歡書。', 'Your mom likes books.'),
      validate: () => v(true),
      checkMeaning: async () => {
        checks++;
        return { contradicts: false, fact: '', reasonEn: '' };
      },
      facts: ['mother: likes gardening'],
      learnerMessage: '我媽媽喜歡【gardening】。',
      maxRegenerations: 0,
      unreliable: () => new Error('unreliable'),
    });
    expect(checks).toBe(1);
    expect(out.misunderstood).toBe(false);
  });

  it('throws when nothing passes the Taiwan check', async () => {
    await expect(
      runChatTurn({
        generate: async () => reply('地铁', 'subway'),
        validate: () => v(false, false),
        facts: [],
        learnerMessage: '捷運',
        maxRegenerations: 0,
        unreliable: () => new Error('unreliable'),
      }),
    ).rejects.toThrow('unreliable');
  });
});
