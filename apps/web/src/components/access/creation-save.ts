// What a save from the editor says about creating, decided from two facts: the
// page has no automation yet, and the person has or has not chosen who may
// reach one. Kept out of the workbench so the rules can be read, and tested,
// on their own.

import type { SaveRefusal } from "@/components/movements/save-notice";

import type { AutomationVerb, Grantee } from "./grantees";

export type CreationStatements = Record<AutomationVerb, Grantee[]>;

export interface CreationState {
  /** Undefined on the new-automation page, until its first save creates the row. */
  movementId: string | undefined;
  /** What the person chose, once they have. */
  statements: CreationStatements | null;
}

/**
 * What a save adds to its input. A new-automation page always says it
 * creates, so a name already held is refused as taken and never overwritten;
 * it sends the chosen statements with that, and only that page does: the
 * server refuses statements on a save over an existing automation.
 */
export function creationParts(state: CreationState): { intent?: "create"; statements?: CreationStatements } {
  if (state.movementId !== undefined) return {};
  return { intent: "create", ...(state.statements !== null ? { statements: state.statements } : {}) };
}

/** Whether the first save must wait for the person to choose who may reach the automation. */
export function mustChooseFirst(state: CreationState): boolean {
  return state.movementId === undefined && state.statements === null;
}

/**
 * Whether a refusal is of the choice itself. The stored choice is then
 * dropped, so the next save asks again rather than resending what was
 * refused.
 */
export function refusesChoice(refused: SaveRefusal): boolean {
  switch (refused.kind) {
    case "statement":
    case "missing_statement":
      return true;
    case "read_only":
    case "name_taken":
    case "name_gone":
    case "connections":
      return false;
    default: {
      const unreachable: never = refused;
      return unreachable;
    }
  }
}
