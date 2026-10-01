import { describe, expect, it } from 'vitest';
import { nextLadderState, type LadderState } from './ladder.js';

describe('nextLadderState', () => {
  it('stays put on a single no-hint correct (streak 1, not yet 2)', () => {
    const state: LadderState = { rung: 1, streak: 0 };
    expect(nextLadderState(state, 'correct')).toEqual({ rung: 1, streak: 1 });
  });

  it('promotes after 2 consecutive no-hint corrects', () => {
    const afterFirst = nextLadderState({ rung: 1, streak: 0 }, 'correct');
    const afterSecond = nextLadderState(afterFirst, 'correct');
    expect(afterSecond).toEqual({ rung: 2, streak: 0 });
  });

  it('promotion caps at rung 3 and does not overflow', () => {
    const atThree: LadderState = { rung: 3, streak: 1 };
    expect(nextLadderState(atThree, 'correct')).toEqual({ rung: 3, streak: 0 });
  });

  it('a wrong-tone hint resets the streak without demoting', () => {
    const state: LadderState = { rung: 2, streak: 1 };
    expect(nextLadderState(state, 'correct_wrong_tone')).toEqual({ rung: 2, streak: 0 });
  });

  it('a wrong-tone hint after a promotion-worthy streak still blocks promotion', () => {
    // 1 correct, then a hint — must NOT promote even though a 3rd correct
    // would otherwise have made streak reach 2 from a stale count.
    const afterCorrect = nextLadderState({ rung: 1, streak: 0 }, 'correct');
    const afterHint = nextLadderState(afterCorrect, 'correct_wrong_tone');
    expect(afterHint).toEqual({ rung: 1, streak: 0 });
  });

  it('a lapse demotes one rung and resets the streak', () => {
    const state: LadderState = { rung: 3, streak: 1 };
    expect(nextLadderState(state, 'wrong')).toEqual({ rung: 2, streak: 0 });
  });

  it('a lapse at rung 1 floors at rung 1', () => {
    const state: LadderState = { rung: 1, streak: 1 };
    expect(nextLadderState(state, 'wrong')).toEqual({ rung: 1, streak: 0 });
  });

  it('a full promote/demote cycle round-trips sensibly', () => {
    let state: LadderState = { rung: 1, streak: 0 };
    state = nextLadderState(state, 'correct');
    state = nextLadderState(state, 'correct');
    expect(state.rung).toBe(2);
    state = nextLadderState(state, 'correct');
    state = nextLadderState(state, 'correct');
    expect(state.rung).toBe(3);
    state = nextLadderState(state, 'wrong');
    expect(state).toEqual({ rung: 2, streak: 0 });
  });
});
