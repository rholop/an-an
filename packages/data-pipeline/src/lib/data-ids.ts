// Phase 38 Part D: every word or grammar id the shipped data refers to must be in the lexicon the
// app loads. A missing id becomes a card Review can't show, so `pnpm audit:data` fails on one.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface IdRef {
  kind: 'word' | 'grammar';
  id: string;
  /** File and JSON path the id was found at. */
  where: string;
}

/** Lexicon word ids (data-pipeline lib/ids.ts prefixes) and grammar ids. */
const WORD_ID = /^(tocfl|moec|supp|tb|custom)-[0-9a-f]{10}$/;
const GRAMMAR_ID = /^gram-[a-z0-9-]+$/;

/** Every word and grammar id anywhere in a JSON value (strings only; sentence ids don't match). */
export function collectIds(value: unknown, where: string): IdRef[] {
  const out: IdRef[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string') {
      if (WORD_ID.test(v)) out.push({ kind: 'word', id: v, where: at });
      else if (GRAMMAR_ID.test(v)) out.push({ kind: 'grammar', id: v, where: at });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
  };
  walk(value, where);
  return out;
}

/** extras.yaml: the word ids of entries that are imported (status proposed or keep). */
export function extrasIds(text: string, where: string): IdRef[] {
  const rows = (yaml.load(text) ?? []) as Array<{ wordId?: string | null; status?: string; headword?: string }>;
  return rows.flatMap((r, i) =>
    r && r.wordId && r.status !== 'drop' ? [{ kind: 'word' as const, id: r.wordId, where: `${where}[${i}] ${r.headword ?? ''}`.trim() }] : [],
  );
}

export interface DataAuditConfig {
  /** id-map.json ids that are not in the lexicon on purpose (id -> reason). */
  retiredIdMapIds?: Record<string, string>;
}

export function readDataAuditConfig(repo: string): DataAuditConfig {
  const file = path.join(repo, 'data/curriculum/data-audit.yaml');
  return existsSync(file) ? ((yaml.load(readFileSync(file, 'utf8')) ?? {}) as DataAuditConfig) : {};
}

const ID_MAP = 'data/build/id-map.json';

/**
 * The audit: ids missing from the lexicon, less the retired id-map ids, and the retired entries that
 * no longer match anything (stale: the id is in the lexicon again, or no longer in id-map.json).
 */
export function auditDataIds(
  refs: readonly IdRef[],
  lexicon: { words: ReadonlyArray<{ id: string }>; grammar: ReadonlyArray<{ id: string }> },
  config: DataAuditConfig = {},
): { missing: IdRef[]; staleRetired: string[] } {
  const retired = new Set(Object.keys(config.retiredIdMapIds ?? {}));
  const all = findMissingIds(refs, lexicon);
  const isRetired = (r: IdRef) => retired.has(r.id) && r.where.startsWith(ID_MAP);
  const usedRetired = new Set(all.filter(isRetired).map((r) => r.id));
  return { missing: all.filter((r) => !isRetired(r)), staleRetired: [...retired].filter((id) => !usedRetired.has(id)) };
}

export function findMissingIds(
  refs: readonly IdRef[],
  lexicon: { words: ReadonlyArray<{ id: string }>; grammar: ReadonlyArray<{ id: string }> },
): IdRef[] {
  const words = new Set(lexicon.words.map((w) => w.id));
  const grammar = new Set(lexicon.grammar.map((g) => g.id));
  return refs.filter((r) => !(r.kind === 'word' ? words : grammar).has(r.id));
}

/** The ids in the files the app ships next to `data/build/lexicon.v2.json`. */
export function shippedIdRefs(repo: string): IdRef[] {
  const refs: IdRef[] = [];
  const json = (rel: string) => JSON.parse(readFileSync(path.join(repo, rel), 'utf8')) as unknown;
  const curriculum = path.join(repo, 'data/curriculum');
  for (const book of existsSync(curriculum) ? readdirSync(curriculum).sort() : []) {
    const bookJson = `data/curriculum/${book}/book.json`;
    if (existsSync(path.join(repo, bookJson))) refs.push(...collectIds(json(bookJson), bookJson));
    const extras = `data/curriculum/${book}/extras.yaml`;
    if (existsSync(path.join(repo, extras))) refs.push(...extrasIds(readFileSync(path.join(repo, extras), 'utf8'), extras));
  }
  const build = path.join(repo, 'data/build');
  for (const f of existsSync(build) ? readdirSync(build).sort() : []) {
    if (/^sentences.*\.json$/.test(f) || f === 'scenarios.json') refs.push(...collectIds(json(`data/build/${f}`), `data/build/${f}`));
  }
  if (existsSync(path.join(repo, ID_MAP))) refs.push(...collectIds(json(ID_MAP), ID_MAP));
  return refs;
}
