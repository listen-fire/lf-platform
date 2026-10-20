// Property-type policy helpers for the KG-write boundary.
//
// Ported from the legacy `apps/api/src/services/knowledge_pipeline/apply.ts`
// per the architectural ruling settled 2026-05-22: the KG owns its own
// write policies; TGs send standard write instructions + evidence and
// the KG decides what to do. The TG adapter
// (`services/translation_graph/adapters/knowledge_graph_writes.ts`)
// imports these helpers to honour `writable_by`, `evaluation_strategy`,
// `cardinality`, and numeric coercion at the write boundary.
//
// `isWritableBy` already lives at `./writable_by.ts` and is reused
// from there — no duplication.

/**
 * Strip common formatting from a string value and parse to a numeric
 * string suitable for the `value_number` numeric column. Mirrors the
 * legacy `apply.ts:coerceNumeric` exactly.
 *
 * - `null`/`undefined` → `null`
 * - finite `number` → `String(n)`
 * - String input: strips commas, leading `$`/`£`/`€`, trailing `%`,
 *   then `Number()`-parses.
 * - Non-finite → `null`.
 */
export function coerceNumeric(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') return isFinite(value) ? String(value) : null;
  const str = String(value).trim().replace(/,/g, '');
  const cleaned = str.replace(/^[$£€]/, '').replace(/%$/, '').trim();
  const num = Number(cleaned);
  return isFinite(num) ? String(num) : null;
}

/**
 * Case-insensitive set-union for multi-cardinality text properties.
 * Mirrors the legacy `apply.ts:unionTextSet`. The first-seen casing
 * wins (existing values are preserved verbatim; incoming values are
 * appended only when their lower-cased form is novel).
 */
export function unionTextSet(
  existing: readonly string[] | null | undefined,
  incoming: readonly string[],
): string[] {
  const seen = new Map<string, string>();
  for (const v of existing ?? []) {
    if (v == null) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  for (const v of incoming) {
    if (v == null) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()];
}

/** The value columns a single-valued property of `valueType` stores `value` in. */
export function setPropertyValue(
  valueType: string | null,
  value: unknown,
): { value_text?: string; value_number?: string | null; value_date?: string; value_boolean?: boolean; value_json?: unknown } {
  if (value == null) return {};
  switch (valueType) {
    case 'number':
      return { value_number: coerceNumeric(value) };
    case 'date':
      return { value_date: String(value) };
    case 'boolean':
      return { value_boolean: Boolean(value) };
    case 'json':
      return { value_json: value };
    default:
      return { value_text: String(value) };
  }
}
