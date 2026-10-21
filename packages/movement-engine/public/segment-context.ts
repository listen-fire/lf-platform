// One run segment as engine state: the run it belongs to, its pinned language
// version, its clock and ids, its cancel gate, the cross-run locks its effects
// take, the host segment it opened, and the run's spend account. Every engine
// entry opens it through the one door (`inRunContext`), so no entry skips
// those safeguards.

export {
  RunLedger,
  closeRunContext,
  hostless,
  languageVersionOf,
  openRunContext,
  pluginSpecNamed,
  publishTrace,
  runLogFields,
  stopwatch,
  inRunContext,
  spendFields,
  throwIfCancelled,
  withDeclaredFiles,
  type ClockAndIds,
  type CrossRunLocks,
  type EngineClock,
  type IdMint,
  type PluginSpecs,
  type RunContext,
  type RunFacts,
  type SegmentHost,
} from '../services/movement_engine/segment_context';
