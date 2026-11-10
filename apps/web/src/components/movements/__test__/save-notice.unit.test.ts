import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SaveRefusalNotice, SaveWarnings, statementReasonSentence, type SaveRefusal, type StatementReason } from "../save-notice";

const notice = (refused: SaveRefusal, options: { choosable: boolean } = { choosable: true }) =>
  renderToStaticMarkup(createElement(SaveRefusalNotice, { refused, ...(options.choosable ? { onChooseAccess: () => {} } : {}) }));

const REASONS: readonly StatementReason[] = [
  "empty",
  "not_found",
  "not_allowed",
  "outsider",
  "not_a_member",
  "not_a_writer",
  "malformed",
  "lf_engine",
  "already_stated",
  "on_overwrite",
];

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
    expect(notice({ kind: "name_taken", name: "Deals" })).toContain("An automation called Deals already exists; pick another name.");
    expect(notice({ kind: "name_gone", name: "Deals" })).toContain("was deleted while you were saving it");
  });

  it("says a refusal of the chosen statements in the page's words by its reason, never the server's text, and lets the person choose again", () => {
    for (const reason of REASONS) {
      const sentence = statementReasonSentence(reason);
      expect(sentence).not.toMatch(/setAccess|Ask the person you are working for/);
      // The server's own text rides along on the response, and must not be what is drawn.
      const fromServer: { kind: "statement"; reason: StatementReason; message: string } = {
        kind: "statement",
        reason,
        message: "setAccess: the server's own text",
      };
      const html = notice(fromServer);
      expect(html).not.toContain("the server");
      expect(html).toContain("Choose who may reach it");
    }
    expect(statementReasonSentence("lf_engine")).toContain("Anyone who reaches it");
  });

  it("offers the choice again only while the automation is new", () => {
    expect(notice({ kind: "statement", reason: "empty" }, { choosable: false })).not.toContain("Choose who may reach it");
    expect(notice({ kind: "missing_statement", missing: ["fire"] }, { choosable: false })).not.toContain("Choose who may reach it");
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
