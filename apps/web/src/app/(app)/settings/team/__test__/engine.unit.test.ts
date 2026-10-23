import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineCard, SWITCH_CONSEQUENCES, type EngineCardProps } from "../engine";

const noop = () => {};

const card = (overrides: Partial<EngineCardProps>) =>
  renderToStaticMarkup(
    createElement(EngineCard, {
      engine: "platform",
      changedAt: null,
      changedByName: null,
      canWrite: true,
      confirming: false,
      busy: false,
      error: null,
      notes: [],
      onAsk: noop,
      onConfirm: noop,
      onCancel: noop,
      ...overrides,
    }),
  );

/** React escapes an apostrophe in text as `&#x27;`. */
const escaped = (text: string) => text.replace(/'/g, "&#x27;");

describe("the team engine toggle", () => {
  it("says where the automations run and offers the other engine", () => {
    const onPlatform = card({ engine: "platform" });
    expect(onPlatform).toContain("On the platform.");
    expect(onPlatform).toContain("Switch to lf");
    expect(onPlatform).not.toContain('data-testid="team-engine-consequence"');

    const inLf = card({ engine: "lf" });
    expect(inLf).toContain("In a cloud lf");
    expect(inLf).toContain("Switch back to the platform");
  });

  it("spells out the consequence before the second click", () => {
    const toLf = card({ engine: "platform", confirming: true });
    expect(toLf).toContain(escaped(SWITCH_CONSEQUENCES.lf));
    expect(SWITCH_CONSEQUENCES.lf).toContain("The platform stops running this team's automations");
    expect(SWITCH_CONSEQUENCES.lf).toContain("A cloud lf must take over");
    expect(SWITCH_CONSEQUENCES.lf).toContain("webhooks and polls it registered for them are removed");
    expect(toLf).toContain('data-testid="team-engine-confirm-yes"');

    const toPlatform = card({ engine: "lf", confirming: true });
    expect(toPlatform).toContain(escaped(SWITCH_CONSEQUENCES.platform));
    expect(SWITCH_CONSEQUENCES.platform).toContain("Stop the cloud lf first");
  });

  it("offers no switch to a read-only member", () => {
    const readOnly = card({ canWrite: false, confirming: true });
    expect(readOnly).toContain("Only members with full access can switch it.");
    expect(readOnly).not.toContain('data-testid="team-engine-switch"');
    expect(readOnly).not.toContain('data-testid="team-engine-confirm-yes"');
  });

  it("names who switched it last, and shows a refusal", () => {
    expect(card({ changedAt: "2026-10-23T08:00:00.000Z", changedByName: "Ada" })).toContain("Switched by Ada on");
    expect(card({ changedAt: "2026-10-23T08:00:00.000Z", changedByName: null })).toContain("Switched on");
    expect(card({ error: "Only members with write access can switch the team's engine." })).toContain(
      'data-testid="team-engine-error"',
    );
  });

  it("lists what a vendor refused after a switch", () => {
    const html = card({ notes: ["acme: external deregistration failed (timeout) — subscription retired locally"] });
    expect(html).toContain('data-testid="team-engine-notes"');
    expect(html).toContain("external deregistration failed");
    expect(card({})).not.toContain('data-testid="team-engine-notes"');
  });
});
