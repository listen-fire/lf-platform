// A run host unit (`manual`, `cron`) has no system behind it: everything it
// publishes and describes is fixed data. Holding that data in one place lets
// the adapter answer from it and lets a catalog that cannot ask an adapter
// (the static one tests check against) project the same surface.

import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'movement-engine/public/catalog';

export interface UnitSurface {
  /** What `listEntryPoints` answers. */
  entries: SchemaEntryPoint[];
  /** The root as a node: its references are the unit's edges. */
  root: SchemaTypeDescriptor;
  /** Every type `describe` answers, by its type id. */
  types: SchemaTypeDescriptor[];
}

/** The type `surface` describes as `typeId`, or null when it has none. */
export function describedType(surface: UnitSurface, typeId: string): SchemaTypeDescriptor | null {
  return surface.types.find((type) => type.typeId === typeId) ?? null;
}
