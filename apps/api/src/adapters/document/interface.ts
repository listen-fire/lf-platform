import type { DocumentProvider } from 'module-runtime';

export type { DocumentProvider };

/** A store key whose `/`-separated segments are each a name, or undefined. */
export function storeKey(key: string): string | undefined {
  const segments = key.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? key : undefined;
}
