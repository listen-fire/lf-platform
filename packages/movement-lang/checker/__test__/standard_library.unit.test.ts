// The built-in table through the engine artifact's `standard_library` export
// (crates/movement-checker/src/types/stdlib.rs): read whole, every entry
// validated at the boundary, and the same rows on every call.

import { standardLibraryTable } from '../standard_library';

describe('standardLibraryTable', () => {
  const table = standardLibraryTable();

  it('round-trips the Rust table through the wasm', () => {
    expect(table.length).toBeGreaterThan(50);
    expect(table.find((b) => b.name === 'SPLIT')).toEqual({
      name: 'SPLIT',
      params: [
        { name: 'text', type: 'text' },
        { name: 'separator', type: 'text', optional: true },
      ],
      returns: 'list of text',
      summary: 'text cut into its trimmed, non-empty parts',
    });
    expect(table.find((b) => b.name === 'COALESCE')?.params).toEqual([{ name: 'values', type: 'any', rest: true }]);
    expect(table.find((b) => b.name === 'URL.HOST')?.returns).toBe('text (or absent)');
  });

  it('gives every built-in a summary, and marks the retired ones', () => {
    for (const b of table) expect(b.summary.length).toBeGreaterThan(0);
    expect(table.filter((b) => b.summary.startsWith('RETIRED')).map((b) => b.name)).toEqual(['KG_EXISTS', 'KG_VALUE', 'EXTRACT_VALUE']);
  });

  it('is read once', () => {
    expect(standardLibraryTable()).toBe(table);
  });
});
