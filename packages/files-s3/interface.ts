// The files slot's contract is module-runtime's (a type-only import: this
// package loads nothing of it at run time).
import type { DocumentProvider } from 'module-runtime';

export type { DocumentProvider };

/** A store key whose `/`-separated segments are each a name, or undefined. */
export function storeKey(key: string): string | undefined {
  const segments = key.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? key : undefined;
}
