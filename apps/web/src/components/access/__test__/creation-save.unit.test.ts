import { creationParts, mustChooseFirst, refusesChoice } from "../creation-save";
import type { CreationStatements } from "../creation-save";
import type { SaveRefusal } from "@/components/movements/save-notice";

const STATEMENTS: CreationStatements = {
  read: [{ kind: "team" }],
  write: [{ kind: "team" }],
};

describe("what a save from the editor says about creating", () => {
  it("a new automation's save says it creates, and carries the chosen statements once there are some", () => {
    expect(creationParts({ movementId: undefined, statements: null })).toEqual({ intent: "create" });
    expect(creationParts({ movementId: undefined, statements: STATEMENTS })).toEqual({ intent: "create", statements: STATEMENTS });
  });

  it("a save over an existing automation sends no statements and does not say it creates, whatever was chosen", () => {
    expect(creationParts({ movementId: "m1", statements: STATEMENTS })).toEqual({});
    expect(creationParts({ movementId: "m1", statements: null })).toEqual({});
  });
});

describe("the first save of a new automation", () => {
  it("waits for the person to choose who may reach it, and goes ahead once they have", () => {
    expect(mustChooseFirst({ movementId: undefined, statements: null })).toBe(true);
    expect(mustChooseFirst({ movementId: undefined, statements: STATEMENTS })).toBe(false);
  });

  it("never waits on an automation that exists", () => {
    expect(mustChooseFirst({ movementId: "m1", statements: null })).toBe(false);
  });
});

describe("a refusal of the choice itself", () => {
  const refusals: [SaveRefusal, boolean][] = [
    [{ kind: "statement", reason: "not_a_member" }, true],
    [{ kind: "missing_statement", missing: ["write"] }, true],
    [{ kind: "read_only" }, false],
    [{ kind: "name_taken", name: "deals" }, false],
    [{ kind: "name_gone", name: "deals" }, false],
    [{ kind: "connections", connections: [], unreadableFiles: [] }, false],
  ];

  it.each(refusals)("%j clears the stored choice: %s", (refused, clears) => {
    expect(refusesChoice(refused)).toBe(clears);
  });
});
