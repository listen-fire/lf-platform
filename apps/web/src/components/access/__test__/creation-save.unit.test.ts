import { asksForLibraryUse, creationParts, mustChooseFirst, refusesChoice } from "../creation-save";
import type { CreationStatements } from "../creation-save";
import type { SaveRefusal } from "@/components/movements/save-notice";

const STATEMENTS: CreationStatements = {
  read: [{ kind: "team" }],
  write: [{ kind: "team" }],
};

describe("what a save from the editor says about creating", () => {
  it("a new automation's save says it creates, and carries the chosen statements once there are some", () => {
    expect(creationParts({ movementId: undefined, statements: null, libraryUse: null })).toEqual({ intent: "create" });
    expect(creationParts({ movementId: undefined, statements: STATEMENTS, libraryUse: null })).toEqual({ intent: "create", statements: STATEMENTS });
  });

  it("a save over an existing automation sends no statements and does not say it creates, whatever was chosen", () => {
    expect(creationParts({ movementId: "m1", statements: STATEMENTS, libraryUse: null })).toEqual({});
    expect(creationParts({ movementId: "m1", statements: null, libraryUse: null })).toEqual({});
  });
});

describe("the first save of a new automation", () => {
  it("waits for the person to choose who may reach it, and goes ahead once they have", () => {
    expect(mustChooseFirst({ movementId: undefined, statements: null, libraryUse: null })).toBe(true);
    expect(mustChooseFirst({ movementId: undefined, statements: STATEMENTS, libraryUse: null })).toBe(false);
  });

  it("never waits on an automation that exists", () => {
    expect(mustChooseFirst({ movementId: "m1", statements: null, libraryUse: null })).toBe(false);
  });
});

describe("a refusal of the choice itself", () => {
  const refusals: [SaveRefusal, boolean][] = [
    [{ kind: "statement", reason: "not_a_member" }, true],
    [{ kind: "missing_statement", missing: ["write"] }, true],
    [{ kind: "read_only" }, false],
    [{ kind: "name_taken", name: "deals" }, false],
    [{ kind: "name_gone", name: "deals" }, false],
    [{ kind: "connections", connections: [] }, false],
    [{ kind: "libraries", libraries: ["lib/finance"] }, false],
    [{ kind: "statement", reason: "first_export" }, false],
    [{ kind: "missing_statement", missing: ["use"] }, false],
    [{ kind: "missing_statement", missing: ["read", "use"] }, true],
  ];

  it.each(refusals)("%j clears the stored choice: %s", (refused, clears) => {
    expect(refusesChoice(refused)).toBe(clears);
  });
});

describe("the use list of a library", () => {
  const USE = [{ kind: "user" as const, userId: "u1" }];

  it("rides a new library's creating save beside the other two lists", () => {
    expect(creationParts({ movementId: undefined, statements: STATEMENTS, libraryUse: USE })).toEqual({
      intent: "create",
      statements: { ...STATEMENTS, use: USE },
    });
  });

  it("is the only statement a save over an existing file may carry, and only once the person has chosen it", () => {
    expect(creationParts({ movementId: "m1", statements: STATEMENTS, libraryUse: USE })).toEqual({ statements: { use: USE } });
  });

  it.each<[SaveRefusal, boolean]>([
    [{ kind: "statement", reason: "first_export" }, true],
    [{ kind: "missing_statement", missing: ["use"] }, true],
    [{ kind: "missing_statement", missing: ["read", "write"] }, false],
    [{ kind: "libraries", libraries: ["lib/finance"] }, false],
  ])("%j asks for it: %s", (refused, asks) => {
    expect(asksForLibraryUse(refused)).toBe(asks);
  });
});
