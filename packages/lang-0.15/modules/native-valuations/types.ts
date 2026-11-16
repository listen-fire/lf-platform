// The names `@lf/native-valuations` answers to, kept apart from the adapter so
// the host can list the module without loading it.

/** The movement tag authors write: `native-valuations`, hyphenated, unlike the
 *  package's slug. */
export const NATIVE_VALUATIONS_ADAPTER_TYPE = 'native-valuations';

/** The event types the platform's Settings provider offers a webhook by
 *  default: a legal entity's changes, as the Valuations outbox worker names
 *  them. A listen's webhook takes every entity's (changes.ts). */
export const NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS = [
  'valuations:legal_entity:create',
  'valuations:legal_entity:update',
  'valuations:legal_entity:delete',
] as const;
