// What a save from the editor says about creating, decided from two facts: the
// page has no automation yet, and the person has or has not chosen who may
// reach one. Kept out of the workbench so the rules can be read, and tested,
// on their own.

import type { SaveRefusal } from "@/components/movements/save-notice";

import type { AutomationVerb, Grantee } from "./grantees";

export type CreationStatements = Record<AutomationVerb, Grantee[]> & { use?: Grantee[] };

export interface CreationState {
  /** Undefined on the new-automation page, until its first save creates the row. */
  movementId: string | undefined;
  /** What the person chose, once they have. */
  statements: Record<AutomationVerb, Grantee[]> | null;
  /** Who may use the file once it exports, when the person has chosen: sent by the save that creates a library or adds a file's first export. */
  libraryUse: Grantee[] | null;
}

/**
 * What a save adds to its input. A new-automation page always says it
 * creates, so a name already held is refused as taken and never overwritten;
 * it sends the chosen statements with that, and only that page does: the
 * server refuses statements on a save over an existing automation, except the
 * use list of a file that has just come to export.
 */
export function creationParts(state: CreationState): { intent?: "create"; statements?: Partial<CreationStatements> } {
  if (state.movementId !== undefined) {
    return state.libraryUse !== null ? { statements: { use: state.libraryUse } } : {};
  }
  return {
    intent: "create",
    ...(state.statements !== null
      ? { statements: { ...state.statements, ...(state.libraryUse !== null ? { use: state.libraryUse } : {}) } }
      : {}),
  };
}

/** Whether a refusal asks for the use list of a file that exports. */
export function asksForLibraryUse(refused: SaveRefusal): boolean {
  switch (refused.kind) {
    case "statement":
      return refused.reason === "first_export";
    case "missing_statement":
      return refused.missing.includes("use");
    case "read_only":
    case "name_taken":
    case "name_gone":
    case "connections":
    case "libraries":
      return false;
    default: {
      const unreachable: never = refused;
      return unreachable;
    }
  }
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
      // The use list of a library is asked for on its own; the choice of read and write stands.
      return refused.reason !== "first_export";
    case "missing_statement":
      return refused.missing.some((verb) => verb !== "use");
    case "read_only":
    case "name_taken":
    case "name_gone":
    case "connections":
    case "libraries":
      return false;
    default: {
      const unreachable: never = refused;
      return unreachable;
    }
  }
}
