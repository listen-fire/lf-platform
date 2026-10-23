// The conformance cases a read-only movements module is held to, shared by the
// contract test and the dev loop's verifier (`dev:lf-movements-verify`).
//
// The slot's own cases that create files (five of the file cases, three of
// the watch cases) cannot hold for a module that is read-only, and the
// contract's read-only cases replace them; the platform's own watch cases in
// the contract test make its changes through the platform instead. The six
// that write nothing are picked by the start of their names; a renamed case is
// found missing, never silently dropped. The cap case holds a quiet watch for
// the module's hold bound (25 s).

import { MOVEMENTS_METHODS } from 'engine-contracts/slots';
import {
  commonSlotCases,
  movementsReadOnlySlotCases,
  movementsSlotCases,
  movementsWatchCapCase,
  type SlotConformanceCase,
} from 'module-runtime/module_wire/conformance';

export const WRITE_FREE_CASE_PREFIXES = [
  'movements: read of a path with nothing at it answers null',
  'movements: a path that is not relative',
  'movements: a write without its expectedVersion',
  'movements: a watch without a cursor answers a cursor and no events',
  'movements: a cursor the module never gave answers resync',
  'movements: a watch without waitMs',
] as const;

/** Each prefix with the slot cases that start with it: exactly one apiece, or the contract changed. */
export const writeFreeMatches = WRITE_FREE_CASE_PREFIXES.map((prefix) => movementsSlotCases.filter((slotCase) => slotCase.name.startsWith(prefix)));

export function readOnlyModuleCases(): SlotConformanceCase[] {
  return [...commonSlotCases('movements', MOVEMENTS_METHODS), ...writeFreeMatches.flat(), ...movementsReadOnlySlotCases, movementsWatchCapCase];
}

/** The common case that sends no credential: the real route answers it 403, not the module's 401. */
export const isTokenlessCase = (slotCase: SlotConformanceCase) => slotCase.name.includes("without the module's token");
