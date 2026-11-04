// The names `@lf/native-valuations` answers to, kept apart from the adapter so
// the host can list the module without loading it.

/** The movement tag authors write: `native-valuations`, hyphenated, unlike the
 *  package's slug. */
export const NATIVE_VALUATIONS_ADAPTER_TYPE = 'native-valuations';

/** The Valuations events a `listen to <vals> { events: [...] }` may subscribe
 *  to — exactly the `row.type` strings the Valuations outbox worker emits, so
 *  the registration's `eventTypes` and the inbound parse agree. Also the
 *  platform's Settings provider's default event types. */
export const NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS = [
  'valuations:legal_entity:create',
  'valuations:legal_entity:update',
  'valuations:legal_entity:delete',
] as const;
