// When a kv's compare-and-set finds the value it expected: the two are the
// same JSON value (objects equal whatever their keys' order), and an unset
// key is expected as undefined.

export function sameJsonValue(stored: unknown, expected: unknown): boolean {
  if (stored === undefined || expected === undefined) return stored === expected;
  return canonical(stored) === canonical(expected);
}

/** A compare-and-set made of a kv's own read and write, for a kv whose
 *  writes are already guarded where it matters (a row's own state
 *  transition): nothing holds another writer off between the two. */
export async function compareThenSet(
  kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> },
  change: { key: string; expected: unknown; value: unknown },
): Promise<boolean> {
  if (!sameJsonValue(await kv.get(change.key), change.expected)) return false;
  await kv.set(change.key, change.value);
  return true;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}
