import { mockCatalog } from '../../checker/catalog';
import { CATALOG_SNAPSHOT_VERSION, EMPTY_CATALOG_SNAPSHOT, catalogSnapshotOf, fromCatalogSnapshot } from 'movement-lang/service/snapshot';

describe("a snapshot's contract version", () => {
  it('is written by the builder', () => {
    expect(catalogSnapshotOf(mockCatalog({}), { adapters: [] }).contractVersion).toBe(CATALOG_SNAPSHOT_VERSION);
  });

  it('reads when it is supported, and when it is absent (a snapshot written before it was carried)', () => {
    expect(() => fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, contractVersion: CATALOG_SNAPSHOT_VERSION })).not.toThrow();
    expect(EMPTY_CATALOG_SNAPSHOT).not.toHaveProperty('contractVersion');
    expect(() => fromCatalogSnapshot(EMPTY_CATALOG_SNAPSHOT)).not.toThrow();
  });

  // Versions 1 and 2 carried a settings listen's keys and event positions,
  // which a version 3 reader would drop without a word.
  it.each([1, 2])('version %d, written before 0.13 retired the settings listen, is refused by name', (contractVersion) => {
    expect(() => fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, contractVersion })).toThrow(
      `the catalog snapshot carries contract version ${contractVersion}, written before 0.13 retired the settings listen; this release reads version 3: rebuild the catalog with it`,
    );
  });

  it('is refused when this release does not read it, naming the contract, the version and the supported set', () => {
    expect(() => fromCatalogSnapshot({ ...EMPTY_CATALOG_SNAPSHOT, contractVersion: 4 })).toThrow(
      'the catalog snapshot carries contract version 4, which this release does not read (supported: 3)',
    );
  });
});
