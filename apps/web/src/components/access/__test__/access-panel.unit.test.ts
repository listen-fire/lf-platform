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

describe("the access panel", () => {
  it("the access panel offers read and write for an automation", () => {
    const html = panel({});
    expect(html).toContain('data-testid="access-read"');
    expect(html).toContain('data-testid="access-write"');
    expect(html).not.toContain('data-testid="access-use"');
    expect(html).not.toContain('data-testid="access-fire"');
    expect(html).not.toContain("Fire");
    expect(html).toContain("Whole team");
    expect(html).toContain("Only you");
  });

  it("offers a change on each list to someone who may change them, and to nobody else", () => {
    const writer = panel({});
    expect(writer).toContain('data-testid="access-edit-read"');
    expect(writer).toContain('data-testid="access-edit-write"');
    expect(writer).not.toContain('data-testid="access-edit-fire"');
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
      editing: { verb: "write", draft: { mode: "people", people: [BOB] } },
      error: "Someone you chose is no longer on the team. Choose again.",
    });
    expect(html).toContain('data-testid="list-editor-write"');
    expect(html).toContain('aria-label="Who may write"');
    expect(html).toContain("Specific people");
    expect(html).toContain('data-testid="access-error"');
    // One list at a time: no other list offers a change while one is open.
    expect(html).not.toContain('data-testid="access-edit-read"');
  });

  it("says when someone on the list has left the team, and that saving leaves them off", () => {
    const html = panel({
      listing: {
        thing: "automation",
        lists: { read: [{ kind: "team" }], write: [{ kind: "user", userId: BOB, name: "Bob", email: null, onTeam: false }] },
        mayChange: true,
        onlyYou: false,
        viewerUserId: ME,
      },
      editing: { verb: "write", draft: { mode: "people", people: [] } },
    });
    expect(html).toContain('data-testid="access-departed"');
  });

  it("offers no one outside the team on any list", () => {
    const html = panel({ editing: { verb: "read", draft: { mode: "people", people: [] } } });
    expect(html).toContain('data-testid="list-editor-read"');
    expect(html).not.toContain("People outside the team");
    expect(html).not.toContain("Everyone on the team");
    expect(html).not.toContain("Anyone who reaches it");
  });

  it("keeps a long name and address to two lines, each cut short with the whole in a tooltip", () => {
    const name = "Maximiliana Featherstonehaugh-Worthington";
    const email = "maximiliana.featherstonehaugh-worthington@verylongcompanyname.example";
    const long: Member = { userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", username: name, email, access: "read" };
    const html = panel({ members: [...members, long], editing: { verb: "read", draft: { mode: "people", people: [] } } });
    expect(html).toContain(`<span class="block truncate" title="${name}">${name}</span>`);
    expect(html).toContain(`title="${email} \u00b7 reads only"`);
    expect(html).toContain("items-start");
  });

  it("offers only members who may write on a write list", () => {
    const reader: Member = { userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", username: "Dee", email: null, access: "read" };
    const html = panel({ members: [...members, reader], editing: { verb: "write", draft: { mode: "people", people: [] } } });
    expect(html).toContain('title="Bob"');
    expect(html).not.toContain('title="Dee"');
  });

  it("cuts a long phrase short inside its chip, with the whole in a tooltip", () => {
    const name = "Maximiliana Featherstonehaugh-Worthington-Smythe the Third of Somewhere Very Long";
    const html = panel({
      listing: { ...readerListing(), lists: { read: [{ kind: "user", userId: BOB, name, email: null, onTeam: true }], write: [] } },
    });
    expect(html).toMatch(new RegExp(`title="${name}"[^>]*class="max-w-full truncate`));
  });
});

describe("the choice at creation", () => {
  it("asks who may see and change it, and nothing about setting it off", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationAccessChoice, { choice: NO_AUTOMATION_CHOICE, onChange: noop, members, viewerUserId: ME }),
    );
    expect(html).toContain("Who may see and change it");
    expect(html).not.toContain("set it off");
    // One dropdown, reading "Choose…" until the person picks, with no hint paragraph beside it.
    expect(html.match(/Choose…/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Who may see and change it"');
    expect(html).toContain('data-testid="choice-see"');
    expect(html).not.toContain('data-testid="choice-fire"');
    expect(html).not.toContain("Nobody else on the team.");
  });

  it("shows the chosen answer's description under its closed dropdown", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationAccessChoice, {
        choice: { ...NO_AUTOMATION_CHOICE, see: "team" },
        onChange: noop,
        members,
        viewerUserId: ME,
      }),
    );
    expect(html).toContain("Whole team");
    expect(html).toContain("Everyone on the team now, and whoever joins. Members who only read can see it but not change it.");
    expect(html.match(/Choose…/g)).toBeNull();
  });

  it("asks who may use a new connection, with nothing chosen", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionAccessChoice, { choice: NO_CONNECTION_CHOICE, onChange: noop, members, viewerUserId: ME }),
    );
    expect(html).toContain("Who may use it");
    expect(html).toContain("Choose…");
    expect(html).toContain('data-testid="choice-use"');
    expect(html).not.toContain("Anyone who reaches it");
  });

  it("keeps the creator on when choosing specific people", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionAccessChoice, { choice: { use: "people", usePeople: [] }, onChange: noop, members, viewerUserId: ME }),
    );
    expect(html).toContain('data-testid="people-picker"');
    const you = html.slice(html.indexOf('title="You"') - 400, html.indexOf('title="You"'));
    expect(you).toMatch(/<input [^>]*disabled=""/);
    expect(you).toMatch(/<input [^>]*checked=""/);
  });
});

function readerListing(): AccessPanelViewProps["listing"] {
  return {
    thing: "automation",
    lists: { read: [{ kind: "user", userId: ME, name: "Me", email: null, onTeam: true }], write: [{ kind: "user", userId: BOB, name: "Bob", email: null, onTeam: true }] },
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
