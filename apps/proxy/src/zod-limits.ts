import type { z } from 'zod';

/**
 * Phase 25: the JSON schema a model is given must say what the zod check will enforce, or a model
 * can return a 7th question that the check then rejects (and the route 502s). `applyZodLimits`
 * copies every array min/max and string max from the zod schema into the provider schema
 * (`minItems`, `maxItems`, `maxLength`: keywords both Gemini and OpenAI accept); `trimToLimits`
 * cuts harmless overruns (a list longer than `maxItems`) before the zod check runs.
 */

type Json = Record<string, unknown>;
type AnyZod = z.ZodTypeAny;

interface ZodDef {
  typeName?: string;
  innerType?: AnyZod;
  schema?: AnyZod;
  type?: AnyZod;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
  checks?: Array<{ kind: string; value?: number }>;
  shape?: () => Record<string, AnyZod>;
  options?: AnyZod[];
}

const def = (s: AnyZod): ZodDef => (s as unknown as { _def: ZodDef })._def;

/** Unwraps optional / nullable / default / effects (refine, transform, preprocess). */
function unwrap(s: AnyZod): AnyZod {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const d = def(cur);
    if (
      d.typeName === 'ZodOptional' ||
      d.typeName === 'ZodNullable' ||
      d.typeName === 'ZodDefault' ||
      d.typeName === 'ZodCatch' ||
      d.typeName === 'ZodReadonly'
    )
      cur = d.innerType!;
    else if (d.typeName === 'ZodEffects') cur = d.schema!;
    else if (d.typeName === 'ZodPipeline') cur = (d as unknown as { in: AnyZod }).in;
    else break;
  }
  return cur;
}

export interface ZodLimit {
  /** JSON-pointer-ish path: properties by name, `[]` for array items. */
  path: string;
  keyword: 'minItems' | 'maxItems' | 'maxLength';
  value: number;
}

/** Every array / string limit in a zod schema. */
export function zodLimits(schema: AnyZod, path = ''): ZodLimit[] {
  const s = unwrap(schema);
  const d = def(s);
  const out: ZodLimit[] = [];
  if (d.typeName === 'ZodObject') {
    const shape =
      typeof d.shape === 'function' ? d.shape() : (d.shape as unknown as Record<string, AnyZod>);
    for (const [k, v] of Object.entries(shape)) out.push(...zodLimits(v, `${path}/${k}`));
  } else if (d.typeName === 'ZodArray') {
    const min = d.exactLength?.value ?? d.minLength?.value;
    const max = d.exactLength?.value ?? d.maxLength?.value;
    if (min !== undefined && min > 0) out.push({ path, keyword: 'minItems', value: min });
    if (max !== undefined) out.push({ path, keyword: 'maxItems', value: max });
    out.push(...zodLimits(d.type!, `${path}[]`));
  } else if (d.typeName === 'ZodString') {
    const max = d.checks
      ?.filter((c) => c.kind === 'max' || c.kind === 'length')
      .map((c) => c.value!);
    if (max && max.length > 0) out.push({ path, keyword: 'maxLength', value: Math.min(...max) });
  } else if (d.typeName === 'ZodUnion' && d.options) {
    // only when every option agrees (e.g. a union of literals): nothing to add
  }
  return out;
}

/** The node of a JSON schema at a `zodLimits` path (undefined when the schema does not describe it). */
export function schemaAt(json: Json, path: string): Json | undefined {
  let cur: Json | undefined = json;
  for (const part of path.match(/\/[^/[]+|\[\]/g) ?? []) {
    if (!cur) return undefined;
    if (part === '[]') cur = cur.items as Json | undefined;
    else cur = (cur.properties as Record<string, Json> | undefined)?.[part.slice(1)];
  }
  return cur;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

const cache = new WeakMap<object, WeakMap<object, Json>>();

/** A copy of `json` with every zod limit written in. Memoized per (json, zod) pair. */
export function applyZodLimits(json: object, zod: AnyZod): Json {
  let byZod = cache.get(json);
  if (!byZod) cache.set(json, (byZod = new WeakMap()));
  const hit = byZod.get(zod);
  if (hit) return hit;
  const out = clone(json) as Json;
  for (const l of zodLimits(zod)) {
    const node = schemaAt(out, l.path);
    if (node) node[l.keyword] = l.value;
  }
  byZod.set(zod, out);
  return out;
}

/** Cuts arrays longer than the schema's `maxItems` (a 7th question when 6 are allowed). Strings are
 * never cut: half a Chinese sentence is not a harmless fix. */
export function trimToLimits(raw: unknown, json: Json): unknown {
  if (Array.isArray(raw)) {
    const max = typeof json.maxItems === 'number' ? json.maxItems : raw.length;
    const items = json.items as Json | undefined;
    return raw.slice(0, max).map((x) => (items ? trimToLimits(x, items) : x));
  }
  if (raw && typeof raw === 'object') {
    const props = json.properties as Record<string, Json> | undefined;
    if (!props) return raw;
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [
        k,
        props[k] ? trimToLimits(v, props[k]!) : v,
      ]),
    );
  }
  return raw;
}
