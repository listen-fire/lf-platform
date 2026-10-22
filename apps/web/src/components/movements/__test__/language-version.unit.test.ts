import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LANGUAGE_VERSION } from "movement-lang";

import { LanguageVersionCell, LanguageVersionNotice } from "../language-version";

const cell = (languageVersion: string) =>
  renderToStaticMarkup(
    createElement("table", null, createElement("tbody", null, createElement("tr", null,
      createElement(LanguageVersionCell, { languageVersion, upgradeDiagnostics: null }),
    ))),
  );

describe("the language version a person sees", () => {
  it("shows a release pin as its semver", () => {
    expect(cell(LANGUAGE_VERSION)).toContain(LANGUAGE_VERSION);
    expect(cell(LANGUAGE_VERSION)).not.toContain("legacy");
  });

  it("shows a legacy id as 'legacy N'", () => {
    expect(cell("4")).toContain("legacy 4");
  });

  it("the notice calls the installed release current and a legacy id behind", () => {
    const notice = (v: string) =>
      renderToStaticMarkup(createElement(LanguageVersionNotice, { languageVersion: v, upgradeDiagnostics: null }));
    expect(notice(LANGUAGE_VERSION)).toContain("the current version.");
    expect(notice("3")).toContain("legacy 3");
    expect(notice("3")).toContain("until you upgrade it");
  });
});
