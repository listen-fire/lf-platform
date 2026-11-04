// The graph's change kinds, as a listen to it names them: the declaring half
// of production's `@lf/kg` events at 0.12. Parsing a delivered change is the
// module's running half, which this package does not carry.

/** The change kinds a `listen to <graph> { events: [...] }` subscribes to, in
 *  Listen-Fire's uniform `record.*` currency (the same names attio and
 *  airtable use, so authoring and dispatch stay adapter-neutral). */
export const KG_SUBSCRIBABLE_EVENTS = ['record.created', 'record.updated', 'record.deleted'] as const;
