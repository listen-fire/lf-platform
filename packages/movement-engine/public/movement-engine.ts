// The engine's front door: run a movement, resume a parked one, check a
// program. The engine runs language version 5 and later on the Rust engine;
// an earlier pin is refused by name.

export { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame } from '../services/movement_engine/rust_run';
export { MovementRunFailed, RunCancelledSignal, runFailureCause } from '../services/movement_engine/errors';
export type {
  CancelGate,
  MovementRunResult,
  MovementWriteRecord,
  ParkSink,
  ResumeMovementInput,
  RunLimitPause,
  RunMovementInput,
} from '../services/movement_engine/run_types';

// A process's boot refuses the retired engine settings.
export { assertEngineConfigured } from '../services/movement_engine/rust_engine';

// What the Rust engine did in this process, counted, and what keeps a
// program off the TypeScript engine.
export * from '../services/movement_engine/rust_stats';
export {
  INTERPRETED_FUNCTIONS,
  isMovementBuiltinFunction,
  listUnsupportedConstructs,
} from '../services/movement_engine/interpretable';

export * as programCheck from '../services/movement_engine/program_check';
export {
  checkAnswer,
  checkPinned,
  checkPinnedInRust,
  fileResolverOf,
  parsePinned,
  type CheckAnswer,
  type CheckedProgram,
  type CheckInput,
  type LinkData,
  type LinkedImportData,
  type Stamp,
} from '../services/movement_engine/program_check';
export { checkInputOf } from '../services/movement_engine/rust_run';

/** This release of the engine. `lf` pins a new project to it and refuses a pin
 *  newer than it; lf's copy is held equal to this one by a cargo test. */
export const ENGINE_VERSION = '0.12.0';
