// The TypeScript engine's front door: run, resume, settle and fire a movement
// pinned to language versions 1–4. A later pin runs on the Rust engine
// (`@listen-fire/engine/public/movement-engine`); `dispatch.ts` picks between
// the two by the run's pin, and is what the platform calls.

export {
  MovementRunFailed,
  RunCancelledSignal,
  fireCallbackBody,
  resumeMovement,
  runFailureCause,
  runMovement,
  settleRaceFrame,
  type CancelGate,
  type MovementRunResult,
  type MovementWriteRecord,
  type ParkSink,
  type ResumeMovementInput,
  type RunLimitPause,
  type RunMovementInput,
} from '../services/movement_engine/run';
