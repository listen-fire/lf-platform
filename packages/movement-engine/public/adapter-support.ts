// What a built-in adapter module reaches beside the adapter contract: the run
// segment's language version, read memo, call counter and call ceiling (each one passes straight
// through outside a segment, so a module served as a process simply has
// none), a bounded-concurrency queue, option matching, and the uniqueness
// rules a resolver answers. `withSegment` is for a module's tests, which open one.

export {
  AdapterCallCeilingExceeded,
  bindAdapterCallCounter,
  currentLanguageVersion,
  fillMemoisedRead,
  forgetMemoisedReads,
  forgetMemoisedReadsUnder,
  isAdapterCallCeilingExceeded,
  memoisedRead,
  withSegment,
  type AdapterCallSystem,
} from '../services/translation_graph/segment_scope';
export { Queue } from 'module-runtime/queue';
export { matchOption } from '../lib/utils/string';
export type { UniquenessConstraints } from 'engine-contracts/uniqueness';
