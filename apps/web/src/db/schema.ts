import Dexie, { type EntityTable } from 'dexie';
import type { Evidence, ItemRef, Skill, SkillCard, Word } from '@anan/core';

/** Schema version for export/import compatibility checks — bump whenever a
 * Dexie `.version()` changes the stored shape in a way old backups can't
 * satisfy. Independent of the lexicon version (data/build/lexicon.v*.json). */
export const DB_SCHEMA_VERSION = 1;

export function itemPk(item: ItemRef, skill: Skill): string {
  return `${item.kind}:${item.id}:${skill}`;
}

/** Dexie row shape for the `items` table: a SkillCard plus its primary key.
 * `card.due`/`card.state` etc. stay nested (plain objects survive structured
 * clone fine) so Dexie can index into them with dot-path indexes. */
export interface ItemRow extends SkillCard {
  pk: string;
}

export interface EvidenceRow extends Evidence {
  id?: number;
}

export interface SettingsRow {
  key: string;
  value: unknown;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export class AnanDB extends Dexie {
  items!: EntityTable<ItemRow, 'pk'>;
  evidence!: EntityTable<EvidenceRow, 'id'>;
  settings!: EntityTable<SettingsRow, 'key'>;
  meta!: EntityTable<MetaRow, 'key'>;
  /** User-added words (source: 'custom'), e.g. from Anki rows that didn't
   * match the built lexicon — merged into the Lexicon at load time
   * (apps/web/src/lib/useLexicon.ts), not part of data/build/lexicon*.json. */
  customWords!: EntityTable<Word, 'id'>;

  constructor(name = 'anan') {
    super(name);
    this.version(1).stores({
      items: 'pk, state, [item.id+skill], card.due, card.lapses, leech',
      evidence: '++id, at, [item.id], kind',
      settings: 'key',
      meta: 'key',
      customWords: 'id, headword',
    });
  }
}
