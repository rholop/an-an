import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOpenChatPersona, loadScenarios } from './scenario-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '../../../../data/scenarios');

describe('loadScenarios: the real data/scenarios/*.yaml files', () => {
  it('parses all seven scenarios (Phase 3: tea shop + EasyCard; Phase 6: five more)', () => {
    const scenarios = loadScenarios(SCENARIOS_DIR);
    // Phase 12/13 add generated textbook scenarios (laixue-1-* … laixue-4-*); they are checked in curriculum-data.test.ts.
    const ids = scenarios.map((s) => s.id).filter((id) => !id.startsWith('laixue-')).sort();
    expect(ids).toEqual([
      'clinic-call',
      'convenience-store',
      'easycard-topup',
      'landlord-deposit',
      'night-market',
      'tea-shop',
      'youbike',
    ]);
  });

  it('every scenario has at least one goal step and a non-empty opener/successLine', () => {
    const scenarios = loadScenarios(SCENARIOS_DIR);
    for (const s of scenarios) {
      expect(s.goalSteps.length).toBeGreaterThan(0);
      expect(s.opener.zh.length).toBeGreaterThan(0);
      expect(s.successLine.zh.length).toBeGreaterThan(0);
      expect(s.npc.name.length).toBeGreaterThan(0);
    }
  });

  it('scenario text uses no mainland terms or simplified characters', async () => {
    const { checkTaiwanness } = await import('@anan/core');
    const scenarios = loadScenarios(SCENARIOS_DIR);
    for (const s of scenarios) {
      for (const text of [
        s.setting,
        s.opener.zh,
        s.successLine.zh,
        ...s.goalSteps.map((g) => g.description),
      ]) {
        const result = checkTaiwanness(text);
        expect(result.isClean, `"${text}" in scenario ${s.id}`).toBe(true);
      }
    }
  });

  it('is deterministic and ordered by id', () => {
    const a = loadScenarios(SCENARIOS_DIR);
    const b = loadScenarios(SCENARIOS_DIR);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(a.map((s) => s.id)).toEqual([...a.map((s) => s.id)].sort());
  });

  it('Phase 6 scenarios span the levels and each has 3-5 goal steps', () => {
    // Textbook scenarios (laixue-*) are longer by design in the higher books; see curriculum-data.test.ts.
    const scenarios = loadScenarios(SCENARIOS_DIR).filter((s) => !s.textbook);
    const mins = new Set(scenarios.map((s) => s.levelRange.min));
    expect(mins.size).toBeGreaterThanOrEqual(4); // a real progression, not one level
    for (const s of scenarios) {
      expect(s.goalSteps.length).toBeGreaterThanOrEqual(3);
      expect(s.goalSteps.length).toBeLessThanOrEqual(5);
      expect(s.vocabExtras.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('Phase 18: the open-chat persona', () => {
  it('open-chat.yaml is not a scenario: the scenario build skips it', () => {
    expect(loadScenarios(SCENARIOS_DIR).map((s) => s.id)).not.toContain('anan');
  });

  it('loads 安安 with a personality, a speech style and particles', () => {
    const p = loadOpenChatPersona(SCENARIOS_DIR);
    expect(p).toMatchObject({ id: 'anan', name: '安安' });
    expect(p.personality.length).toBeGreaterThan(20);
    expect(p.speechStyle.length).toBeGreaterThan(20);
    expect(p.particles.length).toBeGreaterThan(0);
  });
});
