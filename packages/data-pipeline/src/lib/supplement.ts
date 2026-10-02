import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { Level } from '@anan/core';

const LevelSchema = z.union([
  z.literal('N1'),
  z.literal('N2'),
  z.literal('L1'),
  z.literal('L2'),
  z.literal('L3'),
  z.literal('L4'),
  z.literal('L5'),
  z.null(),
]);

const SupplementEntrySchema = z.object({
  headword: z.string(),
  variants: z.array(z.string()).default([]),
  pos: z.array(z.string()).default([]),
  level: LevelSchema.default(null),
  pinyin: z.string(),
  glossEn: z.string(),
  senseNote: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export interface SupplementEntry {
  headword: string;
  variants: string[];
  pos: string[];
  level: Level | null;
  pinyin: string;
  glossEn: string;
  senseNote?: string;
  tags: string[];
}

export function loadSupplementYaml(path: string): SupplementEntry[] {
  const raw = yaml.load(readFileSync(path, 'utf8'));
  const parsed = z.array(SupplementEntrySchema).parse(raw);
  return parsed;
}

const MainlandTermSchema = z.object({
  mainland: z.array(z.string()),
  taiwan: z.string(),
  note: z.string().optional(),
});
export type MainlandTermEntry = z.infer<typeof MainlandTermSchema>;

export function loadMainlandTermsYaml(path: string): MainlandTermEntry[] {
  const raw = yaml.load(readFileSync(path, 'utf8'));
  return z.array(MainlandTermSchema).parse(raw);
}

const SimplifiedPairSchema = z.object({ simplified: z.string(), traditional: z.string() });
export type SimplifiedPair = z.infer<typeof SimplifiedPairSchema>;

export function loadSimplifiedCharsYaml(path: string): SimplifiedPair[] {
  const raw = yaml.load(readFileSync(path, 'utf8'));
  return z.array(SimplifiedPairSchema).parse(raw);
}
