import { describe, expect, it } from 'vitest';
import type { Scenario, TurnRequest } from '@anan/core';
import { buildSystemPrompt, loadPromptTemplate } from './prompt.js';

const scenario: Scenario = {
  id: 'tea-shop',
  title: 'Ordering a drink',
  levelRange: { min: 'N1', max: 'L2' },
  npc: { id: 'clerk', name: '店員', personality: 'friendly', speechStyle: 'short', particles: ['喔', '啦'] },
  setting: 'A bubble tea counter.',
  goalSteps: [
    { id: 'order-drink', description: 'Order a drink', keywordHints: [] },
    { id: 'pay', description: 'Pay', keywordHints: [] },
  ],
  vocabExtras: ['珍珠奶茶'],
  opener: { zh: '歡迎光臨！', en: 'Welcome!' },
  successLine: { zh: '謝謝！', en: 'Thanks!' },
};

const request: TurnRequest = {
  scenarioId: 'tea-shop',
  npcId: 'clerk',
  history: [],
  learnerLevel: 'N2',
  vocab: { knownSample: ['我', '要'], due: ['少冰'], targets: ['珍珠奶茶'], allowedExtras: ['珍珠奶茶'] },
  scaffolding: 'high',
  englishFallback: false,
};

describe('loadPromptTemplate', () => {
  it('loads the real v1 template from data/prompts', () => {
    const template = loadPromptTemplate('v1');
    expect(template).toContain('{{npc_name}}');
    expect(template.length).toBeGreaterThan(100);
  });

  it('throws for a version that does not exist', () => {
    expect(() => loadPromptTemplate('v999')).toThrow();
  });
});

describe('buildSystemPrompt', () => {
  const template = loadPromptTemplate('v1');

  it('substitutes every placeholder (none left over)', () => {
    const result = buildSystemPrompt(template, scenario, request);
    expect(result).not.toMatch(/\{\{\w+\}\}/);
  });

  it('includes the NPC name, personality, and setting', () => {
    const result = buildSystemPrompt(template, scenario, request);
    expect(result).toContain('店員');
    expect(result).toContain('friendly');
    expect(result).toContain('bubble tea counter');
  });

  it('includes numbered goal steps with their ids', () => {
    const result = buildSystemPrompt(template, scenario, request);
    expect(result).toContain('[order-drink] Order a drink');
    expect(result).toContain('[pay] Pay');
  });

  it('includes the vocab lists', () => {
    const result = buildSystemPrompt(template, scenario, request);
    expect(result).toContain('我、要');
    expect(result).toContain('少冰');
    expect(result).toContain('珍珠奶茶');
  });

  it('renders englishFallback as a literal true/false string', () => {
    const on = buildSystemPrompt(template, scenario, { ...request, englishFallback: true });
    const off = buildSystemPrompt(template, scenario, { ...request, englishFallback: false });
    expect(on).toContain('English fallback: true');
    expect(off).toContain('English fallback: false');
  });

  it('falls back to a placeholder label for empty vocab lists', () => {
    const empty = buildSystemPrompt(template, scenario, {
      ...request,
      vocab: { knownSample: [], due: [], targets: [], allowedExtras: [] },
    });
    expect(empty).toContain('(none provided)');
    expect(empty).toContain('(none due)');
  });
});
