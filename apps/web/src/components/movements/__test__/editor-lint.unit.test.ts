import {
  lintsInBrowser,
  remoteToEditorDiagnostics,
  type RemoteDiagnostic,
} from "../editor-lint";

const SOURCE = "function echo(run: <manual-[:Invocation]->>) {\n  return nope\n}\nlisten to manual fire echo\n";

function remote(overrides: Partial<RemoteDiagnostic>): RemoteDiagnostic {
  return {
    code: "MOV_UNKNOWN_NAME",
    message: "no name 'nope'",
    severity: "error",
    line: 2,
    col: 10,
    endLine: 2,
    endCol: 14,
    ...overrides,
  };
}

describe("remoteToEditorDiagnostics", () => {
  it("turns 1-based line/col into offsets into the source", () => {
    const [d] = remoteToEditorDiagnostics(SOURCE, [remote({})]);
    expect(SOURCE.slice(d!.from, d!.to)).toBe("nope");
    expect(d!.span).toEqual({ start: { line: 2, col: 10 }, end: { line: 2, col: 14 } });
    expect(d!.code).toBe("MOV_UNKNOWN_NAME");
    expect(d!.severity).toBe("error");
  });

  it("widens a zero-width span over the word it points at, so the squiggle shows", () => {
    const [d] = remoteToEditorDiagnostics(SOURCE, [remote({ endCol: 10 })]);
    expect(SOURCE.slice(d!.from, d!.to)).toBe("nope");
  });

  it("clamps a span past the end of the source", () => {
    const [d] = remoteToEditorDiagnostics(SOURCE, [remote({ line: 40, col: 1, endLine: 40, endCol: 9 })]);
    expect(d!.from).toBeLessThanOrEqual(SOURCE.length);
    expect(d!.to).toBeLessThanOrEqual(SOURCE.length);
  });
});

describe("the route switch", () => {
  it("a legacy pin lints in the browser; an installed or refused one asks the server", () => {
    expect(lintsInBrowser({ kind: "legacy" })).toBe(true);
    expect(lintsInBrowser({ kind: "installed" })).toBe(false);
    expect(lintsInBrowser({ kind: "refused" })).toBe(false);
  });
});
