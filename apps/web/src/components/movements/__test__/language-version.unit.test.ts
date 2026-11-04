import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LANGUAGE_VERSION } from "movement-lang";

import { saveGoesLive, type EditorLanguageRoute } from "../editor-lint";
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
    const notice = (v: string, kind: EditorLanguageRoute["kind"]) =>
      renderToStaticMarkup(createElement(LanguageVersionNotice, { languageVersion: v, route: { kind }, upgradeDiagnostics: null }));
    expect(notice(LANGUAGE_VERSION, "installed")).toContain("the current version.");
    expect(notice("3", "legacy")).toContain("legacy 3");
    expect(notice("3", "legacy")).toContain("keeps running");
  });

  it("the notice says an automation written for an older release stopped firing", () => {
    const notice = renderToStaticMarkup(
      createElement(LanguageVersionNotice, { languageVersion: "0.12.13", route: { kind: "refused" }, upgradeDiagnostics: null }),
    );
    expect(notice).toContain("stopped firing");
    expect(notice).not.toContain("keeps running");
    expect(notice).not.toContain("checked under");
  });

  it("the notice says one the platform checks under its own version is checked there, and still stopped", () => {
    const notice = renderToStaticMarkup(
      createElement(LanguageVersionNotice, { languageVersion: "0.12.13", route: { kind: "carried" }, upgradeDiagnostics: null }),
    );
    expect(notice).toContain("stopped firing");
    expect(notice).toContain("still checked under");
    expect(notice).toContain("0.12.13");
    expect(notice).not.toContain("the current version.");
  });

  it("the notice says exactly what the platform provides a carried version: run now, and no resume, when it runs", () => {
    const notice = renderToStaticMarkup(
      createElement(LanguageVersionNotice, {
        languageVersion: "0.12.13",
        route: { kind: "carried", provides: { run: true, resume: false, listen: false } },
        upgradeDiagnostics: null,
      }),
    );
    expect(notice).toContain("stopped firing");
    expect(notice).toContain("Run now and test runs run it under");
    expect(notice).toContain("is stopped where it waits");
  });

  it("a clean save goes live only where the route's version fires its listens", () => {
    expect(saveGoesLive({ kind: "installed" })).toBe(true);
    expect(saveGoesLive({ kind: "carried", provides: { run: true, resume: false, listen: false } })).toBe(false);
    expect(saveGoesLive({ kind: "carried", provides: { run: true, resume: true, listen: true } })).toBe(true);
    expect(saveGoesLive({ kind: "carried" })).toBe(false);
    expect(saveGoesLive({ kind: "legacy" })).toBe(false);
    expect(saveGoesLive({ kind: "refused" })).toBe(false);
  });
});
