// The engine's run entry: run a movement, resume a parked one, settle a race
// frame, fire a callback's body. Each opens one segment (`inRunContext`) and
// runs it on the Rust engine (rust_engine.ts). The engine runs language
// version 5 and later; a run pinned earlier is refused at the entry, by name,
// in the words a release uses for a version it does not support. Saved
// movements pinned below 5 run where they were saved, on a platform that
// keeps an engine for them.

import {
  CURRENT_LANGUAGE_VERSION,
  THIS_RELEASE,
  languageVersionDiagnostic,
  type LanguageRelease,
  type LanguageVersion,
} from 'movement-lang';
import {
  refuseUnsupportedParkStateVersion,
  type CallbackBodyInput,
  type RunInput,
  type SettleRaceInput,
} from 'engine-contracts';

import { MovementEngineError, MovementRunFailed } from './errors';
import type { EngineHost } from './host';
import { isoDates } from './host_adapter';
import { checkPinnedInRust, type CheckInput } from './program_check';
import {
  PARKED_ON_TYPESCRIPT,
  checkBeforeRustSegment,
  fireSegmentInRust,
  resumeSegmentInRust,
  runSegmentInRust,
  settleSegmentInRust,
} from './rust_engine';
import type { MovementRunResult, ResumeMovementInput, RunMovementInput } from './run_types';
import { closeRunContext, openRunContext, type RunContext, type RunLedger } from './segment_context';

/** The first language version this engine runs. */
const FIRST_ENGINE_LANGUAGE_VERSION: LanguageVersion = 5;

/** This release as the engine answers for it: the versions it supports, from
 *  the first one the engine runs. */
const ENGINE_RELEASE: LanguageRelease = {
  ...THIS_RELEASE,
  supported: new Set([...THIS_RELEASE.supported].filter((version) => version >= FIRST_ENGINE_LANGUAGE_VERSION)),
};

export async function runMovement(given: RunMovementInput): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseEarlierPin(input);
  // The program is checked here, by the Rust checker, before its segment
  // opens, so a program that fails its check makes no host request. The
  // engine then checks it again itself (`nativeCheck`), its stamps and import
  // link that check's; the host is never asked.
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => runSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * Resume a parked movement run forward from its parked leaf. The `source` MUST
 * be the version-pinned source the run parked against, so every lexical
 * address is byte-identical.
 */
export async function resumeMovement(given: ResumeMovementInput): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseUnsupportedParkStateVersion(input.state.version);
  refuseEarlierPin(input);
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => resumeSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * Settle a race frame whose branches completed under batch resume: called by
 * the await-resume worker once per deferred frame after the whole batch pass.
 */
export async function settleRaceFrame(given: SettleRaceInput & { host: EngineHost }): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseUnsupportedParkStateVersion(input.state.version);
  refuseEarlierPin(input);
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => settleSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * Run a fired callback's body against its captured continuation. `source` MUST
 * be the run's version-pinned source, so the address resolves to the same
 * expression it was minted from.
 */
export async function fireCallbackBody(given: CallbackBodyInput & { host: EngineHost }): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseUnsupportedParkStateVersion(input.state.version);
  refuseEarlierPin(input);
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => fireSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * A run pinned below the first version this engine runs is refused, in the
 * words a release uses for a version it does not support. A run pinned to a
 * version the engine runs that the TypeScript engine parked (under the
 * retired MOVEMENT_ENGINE_V5_ON_TS switch) has no engine to resume on.
 */
function refuseEarlierPin(input: RunInput & { parkedOnEngine?: 'ts' | 'rust' }): void {
  const languageVersion = input.languageVersion ?? CURRENT_LANGUAGE_VERSION;
  if (languageVersion < FIRST_ENGINE_LANGUAGE_VERSION) {
    const refusal = languageVersionDiagnostic(languageVersion, ENGINE_RELEASE);
    throw new MovementEngineError(
      'MOVENG_LANGUAGE_VERSION',
      refusal?.message ?? `this engine runs language version ${FIRST_ENGINE_LANGUAGE_VERSION} and later`,
    );
  }
  if (input.parkedOnEngine === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language version ${languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
}

/** The run's input with its event read as the engine reads a host's data: a
 *  `Date` in it is its ISO text (`isoDates`). */
export function withIsoEvent<I extends RunInput>(input: I): I {
  const event = isoDates(input.event);
  return event === input.event ? input : { ...input, event };
}

/** What the check reads of a run's input. */
export function checkInputOf(input: RunInput): CheckInput {
  return {
    source: input.source,
    catalog: input.catalog,
    ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
  };
}

/**
 * Every way into an engine opens the same door: one segment — its host
 * segment (the adapters' read memo and call ceiling), its cross-run lock
 * holder, the run's spend account — closed however the segment ends. An
 * entry point that skipped it would lose those safeguards silently, so they
 * all go through here.
 *
 * What the segment's adapter calls spent is known only once the host segment
 * closes, so the spend on the result (or on a failure's partial result) is
 * read after the close.
 */
export async function inRunContext(
  input: RunMovementInput,
  run: (context: RunContext) => Promise<MovementRunResult>,
): Promise<MovementRunResult> {
  const context = await openRunContext({
    host: input.host,
    teamId: input.teamId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    languageVersion: input.languageVersion ?? CURRENT_LANGUAGE_VERSION,
    ...(input.firedAt !== undefined ? { firedAt: input.firedAt } : {}),
    spend: {
      priorMicrodollars: input.priorSpentMicrodollars ?? 0,
      capBaselineMicrodollars: input.capBaselineMicrodollars ?? 0,
      ...(input.costCapMicrodollars !== undefined ? { capMicrodollars: input.costCapMicrodollars } : {}),
    },
  });
  let result: MovementRunResult;
  try {
    try {
      result = await run(context);
    } finally {
      await closeRunContext(context, input.host);
    }
  } catch (error) {
    if (error instanceof MovementRunFailed) Object.assign(error.partial, spendFields(context.ledger));
    throw error;
  }
  return { ...result, ...spendFields(context.ledger) };
}

/** What a segment spent, as its result carries it. */
export function spendFields(
  ledger: RunLedger,
): Pick<MovementRunResult, 'spentMicrodollars' | 'runSpentMicrodollars' | 'spentBySource'> {
  const spend = ledger.spend;
  return {
    ...(spend.segmentMicrodollars > 0
      ? { spentMicrodollars: spend.segmentMicrodollars, spentBySource: spend.bySource }
      : {}),
    ...(spend.runMicrodollars > 0 ? { runSpentMicrodollars: spend.runMicrodollars } : {}),
  };
}
