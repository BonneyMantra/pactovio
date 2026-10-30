import { z } from 'zod';
import { chat, type ChatParams } from './chat';
import type { ChatResult } from './types';

export class JsonValidationError extends Error {
  constructor(message: string, public lastText: string) {
    super(message);
  }
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('response is not valid JSON');
  }
}

/**
 * Structured output: `response_format: json_schema` derived from the zod schema, validate, ONE retry
 * that feeds the validation error back to the model.
 */
export async function chatJSON<S extends z.ZodType>(
  schema: S,
  p: ChatParams & { schemaName?: string },
): Promise<{ data: z.output<S>; result: ChatResult }> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const extra = { ...p.extra, response_format: { type: 'json_schema', json_schema: { name: p.schemaName ?? 'result', strict: true, schema: jsonSchema } } };
  let messages = p.messages;
  let last: ChatResult | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await chat({ ...p, messages, extra, purpose: attempt ? `${p.purpose} (retry)` : p.purpose });
    try {
      return { data: schema.parse(extractJson(last.text)), result: last };
    } catch (e) {
      const why = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message;
      if (attempt === 1) throw new JsonValidationError(`Model output failed validation: ${why}`, last.text);
      messages = [...messages, { role: 'assistant', content: last.text }, { role: 'user', content: `Your JSON was invalid: ${why}. Return only corrected JSON that matches the schema.` }];
    }
  }
  throw new JsonValidationError('unreachable', last?.text ?? '');
}
