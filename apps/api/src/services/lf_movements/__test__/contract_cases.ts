// The conformance cases a read-only movements module is held to, shared by the
// contract test and the dev loop's verifier (`dev:lf-movements-verify`).
//
// The slot's own five cases that create files cannot hold for a module that is
// read-only, and the contract's read-only cases replace them. The three that
// write nothing are picked by the start of their names; a renamed case is
// found missing, never silently dropped.

import { MOVEMENTS_METHODS } from 'engine-contracts/slots';
import {
  commonSlotCases,
  movementsReadOnlySlotCases,
  movementsSlotCases,
  type SlotConformanceCase,
} from 'module-runtime/module_wire/conformance';

export const WRITE_FREE_CASE_PREFIXES = [
  'movements: read of a path with nothing at it answers null',
  'movements: a path that is not relative',
  'movements: a write without its expectedVersion',
] as const;

/** Each prefix with the slot cases that start with it: exactly one apiece, or the contract changed. */
export const writeFreeMatches = WRITE_FREE_CASE_PREFIXES.map((prefix) => movementsSlotCases.filter((slotCase) => slotCase.name.startsWith(prefix)));

export function readOnlyModuleCases(): SlotConformanceCase[] {
  return [...commonSlotCases('movements', MOVEMENTS_METHODS), ...writeFreeMatches.flat(), ...movementsReadOnlySlotCases];
}

/** The common case that sends no credential: the real route answers it 403, not the module's 401. */
export const isTokenlessCase = (slotCase: SlotConformanceCase) => slotCase.name.includes("without the module's token");
