// Phase 38 Part D: `pnpm audit:data` fails on an id the shipped data references but the lexicon lacks.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditDataIds, collectIds, extrasIds, readDataAuditConfig, shippedIdRefs } from './lib/data-ids.js';

const REPO = path.resolve(__dirname, '../../..');
const lexicon = { words: [{ id: 'tocfl-0000000001' }, { id: 'tb-00000000aa' }], grammar: [{ id: 'gram-le-completion' }] };

function fixtureRepo(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'anan-data-audit-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

describe('audit:data (Phase 38 Part D)', () => {
  it('fails on a fixture book.json referencing a missing id', () => {
    const repo = fixtureRepo({
      'data/curriculum/laixue-1/book.json': {
        textbook: { lessons: [{ id: 'laixue-1-L01', vocab: ['tocfl-0000000001'], extra: ['tocfl-00000000ff'], grammar: ['gram-le-completion'] }] },
        wordNotes: [{ wordId: 'tb-00000000aa' }],
      },
    });
    const { missing } = auditDataIds(shippedIdRefs(repo), lexicon);
    expect(missing).toEqual([{ kind: 'word', id: 'tocfl-00000000ff', where: 'data/curriculum/laixue-1/book.json.textbook.lessons[0].extra[0]' }]);
  });

  it('checks extras.yaml (dropped rows aside), sentence banks and grammar ids; sentence ids are not word ids', () => {
    expect(extrasIds('- {headword: 兄弟, wordId: tocfl-00000000ee, status: keep}\n- {headword: 爸爸, wordId: tocfl-00000000dd, status: drop}\n- {headword: 堂兄妹, wordId: null}\n', 'x')).toEqual([
      { kind: 'word', id: 'tocfl-00000000ee', where: 'x[0] 兄弟' },
    ]);
    const refs = collectIds({ sentences: [{ id: 'tb-L01-001', targetWordId: 'tocfl-0000000001', grammarIds: ['gram-ba-directional'] }] }, 's');
    expect(auditDataIds(refs, lexicon).missing.map((r) => r.id)).toEqual(['gram-ba-directional']);
  });

  it('a retired id-map id passes only in id-map.json, and a stale retired entry fails', () => {
    const repo = fixtureRepo({ 'data/build/id-map.json': { '姓|xìng|laixue-1': 'tb-00000000bb' } });
    const config = { retiredIdMapIds: { 'tb-00000000bb': 'never shipped', 'tb-00000000cc': 'gone' } };
    const result = auditDataIds(shippedIdRefs(repo), lexicon, config);
    expect(result.missing).toEqual([]);
    expect(result.staleRetired).toEqual(['tb-00000000cc']);
    // the same id referenced by a book is still a finding
    expect(auditDataIds(collectIds({ vocab: ['tb-00000000bb'] }, 'data/curriculum/b/book.json'), lexicon, config).missing).toHaveLength(1);
  });

  it('passes on the repo as shipped', async () => {
    const { readFileSync } = await import('node:fs');
    const lex = JSON.parse(readFileSync(path.join(REPO, 'data/build/lexicon.v2.json'), 'utf8'));
    const result = auditDataIds(shippedIdRefs(REPO), lex, readDataAuditConfig(REPO));
    expect(result).toEqual({ missing: [], staleRetired: [] });
  });
});
