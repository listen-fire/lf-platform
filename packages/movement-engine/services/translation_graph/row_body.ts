// Reading a stored mapping row body leniently, with a warning, is the host's:
// the contract (`engine-contracts/catalog`) states only the schema.

import { translationGraphRowBodySchema, type TranslationGraphRowBody } from 'engine-contracts/catalog';

/**
 * Lenient parse of a mapping row body — tolerates malformed JSONB so
 * reads never 500 the page. Returns null when the body is not
 * recognisable as a mapping.
 *
 * Parse failures emit a `console.warn` with a summary of the zod errors:
 * silent failures here surface downstream as misleading "referenced
 * mapping not found" errors (G1-v4 / Gap G), costing diagnostic time.
 * The warn includes the schema location + the first few issue paths so
 * the caller can grep the source straight away.
 */
export function parseRowBodyLenient(value: unknown): TranslationGraphRowBody | null {
  if (!value || typeof value !== 'object') {
    console.warn(
      '[parseRowBodyLenient] row body is not an object — returning null',
      { type: typeof value, isNull: value === null },
    );
    return null;
  }
  const parsed = translationGraphRowBodySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  console.warn(
    '[parseRowBodyLenient] translationGraphRowBodySchema rejected row body — returning null. ' +
      'See packages/engine-contracts/catalog.ts (translationGraphRowBodySchema) ' +
      'and packages/engine-contracts/expression/expression.ts (expressionSchema).',
    {
      issueCount: parsed.error.issues.length,
      firstIssues: issues,
    },
  );
  return null;
}
