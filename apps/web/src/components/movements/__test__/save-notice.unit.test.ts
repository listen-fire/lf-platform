import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SaveRefusalNotice, SaveWarnings, type SaveRefusal } from "../save-notice";

const notice = (refused: SaveRefusal) => renderToStaticMarkup(createElement(SaveRefusalNotice, { refused, onChooseAccess: () => {} }));

describe("a save that was not the saver's to make", () => {
  it("lists each connection they may not use with the file that names it, and a file they can't read as such", () => {
    const html = notice({
      kind: "connections",
      connections: [{ connection: "finance_attio", file: "Deals" }],
      unreadableFiles: ["Payroll"],
    });
    expect(html).toContain('data-testid="save-refused-connections"');
    expect(html).toContain("finance_attio");
    expect(html).toContain("named in");
    expect(html).toContain("Deals");
    expect(html).toContain("Payroll");
    expect(html).toContain("a file you can&#x27;t read");
    // The connection a file the saver can't read names is never shown.
    expect(html).not.toContain("payroll_");
  });

  it("offers the choice of who may reach a new automation when its save lacked one", () => {
    const html = notice({ kind: "missing_statement", missing: ["read", "write", "fire"] });
    expect(html).toContain("Choose who may reach it");
  });

  it("says each other refusal in plain words", () => {
    expect(notice({ kind: "read_only" })).toContain("You may read this automation but not change it.");
    expect(notice({ kind: "name_taken", name: "Deals" })).toContain("is taken");
    expect(notice({ kind: "name_gone", name: "Deals" })).toContain("was deleted while you were saving it");
    expect(notice({ kind: "statement", message: "The read list can't be emptied." })).toContain("The read list can&#x27;t be emptied.");
  });
});

describe("what a save that went through warns of", () => {
  it("shows each warning, and nothing when there are none", () => {
    const html = renderToStaticMarkup(createElement(SaveWarnings, { warnings: ['Some who may read this automation may not use the connection "finance".'] }));
    expect(html).toContain('data-testid="save-warnings"');
    expect(html).toContain("may not use the connection");
    expect(renderToStaticMarkup(createElement(SaveWarnings, { warnings: [] }))).toBe("");
  });
});
