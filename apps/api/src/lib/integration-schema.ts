import { sha256Hex } from './db';
/** Canonical JSON makes metadata fingerprints independent of object-key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const fingerprint = (value: unknown) => sha256Hex(canonical(value));
type Schema = Record<string, any>;
/** Bounded validator for pinned provider JSON schemas; unsupported assertions fail closed. */
export function matchesSchema(value: unknown, schema: Schema, root: Schema = schema, depth = 0): boolean {
  if (depth > 40 || !schema || typeof schema !== 'object') return false;
  const next = (v: unknown, s: Schema) => matchesSchema(v, s, root, depth + 1);
  if (schema.$ref) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return false;
    let ref: any = root;
    for (const key of schema.$ref.slice(2).split('/')) ref = ref?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
    return !!ref && next(value, ref);
  }
  if (schema.anyOf && !schema.anyOf.some((s: Schema) => next(value, s))) return false;
  if (schema.oneOf && schema.oneOf.filter((s: Schema) => next(value, s)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every((s: Schema) => next(value, s))) return false;
  if (['not', 'if', 'patternProperties', 'unevaluatedProperties', 'format', 'minProperties', 'maxProperties', 'exclusiveMinimum',
    'exclusiveMaximum', 'multipleOf', 'uniqueItems', 'additionalItems', 'prefixItems', 'dependentRequired', 'dependentSchemas',
    'contains', 'minContains', 'maxContains', 'propertyNames', 'unevaluatedItems'].some(k => k in schema)) return false;
  if ('const' in schema && canonical(value) !== canonical(schema.const)) return false;
  if (schema.enum && !schema.enum.some((v: unknown) => canonical(v) === canonical(value))) return false;
  const types = schema.type ? Array.isArray(schema.type) ? schema.type : [schema.type] : [];
  if (types.length && !types.some((t: string) => t === 'null' ? value === null : t === 'array' ? Array.isArray(value)
    : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : t === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : typeof value === t)) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    if (value.length > 100000 || schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000 || schema.maxItems !== undefined && value.length > schema.maxItems || schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.items && !value.every(v => next(v, schema.items))) return false;
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).length > 300 || schema.required?.some((key: string) => !(key in obj))) return false;
    for (const [key, val] of Object.entries(obj)) {
      if (schema.properties?.[key]) { if (!next(val, schema.properties[key])) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !next(val, schema.additionalProperties)) return false;
    }
  }
  return true;
}
