import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AccessLoadFailed, AccessPanelView, ONLY_YOU, type AccessPanelViewProps } from "../access-panel-view";
import { AutomationAccessChoice, ConnectionAccessChoice } from "../choice";
import { NO_AUTOMATION_CHOICE, NO_CONNECTION_CHOICE, type Member } from "../grantees";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const noop = () => {};

const members: Member[] = [
  { userId: ME, username: "Me", email: "me@acme.com", access: "write" },
  { userId: BOB, username: "Bob", email: "bob@acme.com", access: "write" },
];

const panel = (overrides: Partial<AccessPanelViewProps>) =>
  renderToStaticMarkup(
    createElement(AccessPanelView, {
      listing: {
        thing: "automation",
        lists: {
          read: [{ kind: "team" }],
          write: [{ kind: "user", userId: ME, name: "Me", email: "me@acme.com", onTeam: true }],
          fire: [{ kind: "domain", domain: "acme.com" }],
        },
        mayChange: true,
        onlyYou: false,
        viewerUserId: ME,
      },
      editing: null,
      members,
      busy: false,
      error: null,
      onEdit: noop,
      onDraft: noop,
      onSave: noop,
      onCancel: noop,
      ...overrides,
    }),
  );

/** React escapes an apostrophe in text as `&#x27;`. */
const escaped = (text: string) => text.replace(/'/g, "&#x27;");

describe("the access panel", () => {
  it("shows an automation's read, write and fire lists in plain words", () => {
    const html = panel({});
    for (const verb of ["read", "write", "fire"]) expect(html).toContain(`data-testid="access-${verb}"`);
    expect(html).not.toContain('data-testid="access-use"');
    expect(html).toContain("Whole team");
    expect(html).toContain("Only you");
    expect(html).toContain("Anyone at @acme.com");
  });

  it("offers a change on each list to someone who may change them, and to nobody else", () => {
    const writer = panel({});
    expect(writer).toContain('data-testid="access-edit-read"');
    expect(writer).toContain('data-testid="access-edit-fire"');
    expect(writer).not.toContain('data-testid="access-read-only"');

    const reader = panel({ listing: { ...readerListing(), mayChange: false } });
    expect(reader).not.toContain("access-edit-");
    expect(reader).toContain('data-testid="access-read-only"');
  });

  it("says only you can see it when its lists admit the viewer alone", () => {
    expect(panel({ listing: { ...readerListing(), onlyYou: true } })).toContain(ONLY_YOU);
    expect(panel({})).not.toContain(ONLY_YOU);
  });

  it("shows a connection's use list alone", () => {
    const html = panel({
      listing: { thing: "connection", lists: { use: [{ kind: "team" }] }, mayChange: true, onlyYou: false, viewerUserId: ME },
    });
    expect(html).toContain('data-testid="access-use"');
    expect(html).not.toContain('data-testid="access-read"');
  });

  it("opens the list being changed with its choice made, and says why a change was refused", () => {
    const html = panel({
      editing: { verb: "fire", draft: { mode: "people", people: [BOB], withTeam: false, outsiders: "@acme.com" } },
      error: "Only people on the team can be named on the fire list.",
    });
    expect(html).toContain('data-testid="list-editor-fire"');
    expect(html).toContain('aria-checked="true" data-value="people"');
    expect(html).toContain("People outside the team");
    expect(html).toContain('data-testid="access-error"');
    // One list at a time: no other list offers a change while one is open.
    expect(html).not.toContain('data-testid="access-edit-read"');
  });

  it("offers no outsiders on a list other than firing", () => {
    const html = panel({ editing: { verb: "read", draft: { mode: "people", people: [], withTeam: false, outsiders: "" } } });
    expect(html).toContain('data-testid="list-editor-read"');
    expect(html).not.toContain("People outside the team");
    expect(html).not.toContain(escaped("Anyone who reaches it"));
  });
});

describe("the choice at creation", () => {
  it("asks who may see and change it and who may set it off, with nothing chosen", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationAccessChoice, { choice: NO_AUTOMATION_CHOICE, onChange: noop, members, viewerUserId: ME }),
    );
    expect(html).toContain("Who may see and change it");
    expect(html).toContain("Who may set it off");
    for (const label of ["Only me", "Whole team", "Specific people", "Anyone who reaches it"]) expect(html).toContain(label);
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('aria-checked="true"');
  });

  it("asks who may use a new connection, with nothing chosen", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionAccessChoice, { choice: NO_CONNECTION_CHOICE, onChange: noop, members, viewerUserId: ME }),
    );
    expect(html).toContain("Who may use it");
    expect(html).not.toContain('aria-checked="true"');
    expect(html).not.toContain("Anyone who reaches it");
  });

  it("keeps the creator on when choosing specific people", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionAccessChoice, { choice: { use: "people", usePeople: [] }, onChange: noop, members, viewerUserId: ME }),
    );
    expect(html).toContain('data-testid="people-picker"');
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/><span>You<\/span>/);
  });
});

function readerListing(): AccessPanelViewProps["listing"] {
  return {
    thing: "automation",
    lists: { read: [{ kind: "user", userId: ME, name: "Me", email: null, onTeam: true }], write: [{ kind: "user", userId: BOB, name: "Bob", email: null, onTeam: true }], fire: [{ kind: "team" }] },
    mayChange: true,
    onlyYou: false,
    viewerUserId: ME,
  };
}

describe("when the panel's lists could not be read", () => {
  it("says so, so a missing panel is not mistaken for an unrestricted thing", () => {
    const html = renderToStaticMarkup(createElement(AccessLoadFailed, { thing: "connection" }));
    expect(html).toContain('data-testid="access-load-failed"');
    expect(html).toContain("Couldn&#x27;t load who may reach this connection.");
  });
});
