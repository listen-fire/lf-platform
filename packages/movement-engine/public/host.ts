// The EngineHost: the one interface a shell implements to run movements, the
// families of calls on it, and the kit of ready-made parts for building one.

export * from '../services/movement_engine/host';
export {
  BARE_HOST,
  NEVER_CANCELLED,
  RANDOM_IDS,
  SegmentDirectory,
  WALL_CLOCK,
  actingPrincipalOf,
  appendingInto,
  closeSegmentWith,
  openSegmentWith,
  type ActingUserLookup,
  type QueuedWake,
  type SegmentFacts,
} from '../services/movement_engine/host_kit';
export {
  adapterErrorOf,
  adapterTable,
  type AdapterTable,
  type ClassifyHostError,
  CredentialNotTenants,
  type CredentialOwnership,
  type LiveAdapterResolver,
} from '../services/translation_graph/engine/adapter_table';
// The host's segment bookkeeping: what a segment's adapter calls have read,
// counted and spent, and the scope each call runs in.
export { hostSegments, segmentScopedCalls } from '../services/translation_graph/segment_scope';
// The host as an engine reaches it: one adapter per resolved binding, its call
// ceiling, and a host's data read as the engine reads it (a Date is its ISO
// text, in an answer and in the run's event alike).
export {
  hostAdapter,
  hostInstanceOf,
  isAdapterCallCeilingReached,
  isoDates,
  withIsoEvent,
} from '../services/movement_engine/host_adapter';
