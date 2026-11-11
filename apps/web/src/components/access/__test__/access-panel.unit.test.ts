import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AccessLoadFailed,
  AccessPanelView,
  DROPS_OWN_MESSAGES,
  HEARS_OWN_MESSAGES,
  ONLY_YOU,
  type AccessPanelViewProps,
  type DropsOwnMessagesLine,
} from "../access-panel-view";
import { AutomationAccessChoice, ConnectionAccessChoice } from "../choice";
import { NO_AUTOMATION_CHOICE, NO_CONNECTION_CHOICE, type ListDraft, type Member } from "../grantees";

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
        carriedPin: false,
        teamRunsOnLf: false,
        dropsOwnMessages: [],
      },
      editing: null,
      members,
      engine: "platform",
      busy: false,
      error: null,
      onEdit: noop,
      onDraft: noop,
      onSave: noop,
      onCancel: noop,
      settingBusy: false,
      settingError: null,
      onDropOwnMessages: noop,
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
      listing: { thing: "connection", lists: { use: [{ kind: "team" }] }, mayChange: true, onlyYou: false, viewerUserId: ME, carriedPin: false, teamRunsOnLf: false, dropsOwnMessages: [] },
    });
    expect(html).toContain('data-testid="access-use"');
    expect(html).not.toContain('data-testid="access-read"');
  });

  it("opens the list being changed with its choice made, and says why a change was refused", () => {
    const html = panel({
      editing: { verb: "fire", draft: { mode: "people", people: [BOB], withTeam: false, outsiders: "@acme.com" } },
      error: "Someone you chose is no longer on the team. Choose again.",
    });
    expect(html).toContain('data-testid="list-editor-fire"');
    expect(html).toContain('aria-label="Who may fire"');
    expect(html).toContain("Specific people");
    expect(html).toContain("Pick people on the team, or outside it.");
    // The list already names outsiders, so their field starts in view.
    expect(html).toContain("People outside the team");
    expect(html).not.toContain("+ Add people outside the team");
    expect(html).toContain('data-testid="access-error"');
    // One list at a time: no other list offers a change while one is open.
    expect(html).not.toContain('data-testid="access-edit-read"');
  });

  it("offers only \u201cAnyone who reaches it\u201d for firing on a team that runs on lf", () => {
    const html = panel({ engine: "lf", editing: { verb: "fire", draft: { mode: "anyone", people: [], withTeam: false, outsiders: "" } } });
    // One possible answer is stated, not asked.
    expect(html).toContain("Anyone who reaches it");
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("Specific people");
    expect(html.slice(html.indexOf('data-testid="list-editor-fire"'))).not.toContain("Whole team");
  });

  it("says the fire list is not checked while the team runs on lf", () => {
    const html = panel({ listing: { ...readerListing(), teamRunsOnLf: true } });
    expect(html.slice(html.indexOf('data-testid="access-fire"'))).toContain("Not checked while this team runs on lf.");
    expect(panel({ listing: readerListing() })).not.toContain("Not checked while this team runs on lf.");
  });

  it("offers only \u201cAnyone who reaches it\u201d for firing an automation still on an older language version", () => {
    const html = panel({
      listing: { ...readerListing(), carriedPin: true },
      editing: { verb: "fire", draft: { mode: "anyone", people: [], withTeam: false, outsiders: "" } },
    });
    expect(html).toContain("Anyone who reaches it");
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("Specific people");
    expect(html.slice(html.indexOf('data-testid="list-editor-fire"'))).not.toContain("Whole team");
  });

  it("says when someone on the list has left the team, and that saving leaves them off", () => {
    const html = panel({
      listing: {
        thing: "automation",
        lists: { read: [{ kind: "team" }], write: [{ kind: "user", userId: BOB, name: "Bob", email: null, onTeam: false }], fire: [{ kind: "team" }] },
        mayChange: true,
        onlyYou: false,
        viewerUserId: ME,
        carriedPin: false,
        teamRunsOnLf: false,
        dropsOwnMessages: [],
      },
      editing: { verb: "write", draft: { mode: "people", people: [], withTeam: false, outsiders: "" } },
    });
    expect(html).toContain('data-testid="access-departed"');
  });

  it("offers no outsiders on a list other than firing", () => {
    const html = panel({ editing: { verb: "read", draft: { mode: "people", people: [], withTeam: false, outsiders: "" } } });
    expect(html).toContain('data-testid="list-editor-read"');
    expect(html).not.toContain("People outside the team");
    expect(html).not.toContain("Everyone on the team");
    expect(html).not.toContain("+ Add people outside the team");
    expect(html).not.toContain(escaped("Anyone who reaches it"));
  });

  const fireEditor = (draft: ListDraft, among: Member[] = members) => panel({ members: among, editing: { verb: "fire", draft } });

  it("keeps people outside the team behind a button until the list names some or one is asked for", () => {
    const html = fireEditor({ mode: "people", people: [], withTeam: false, outsiders: "" });
    expect(html).toContain("+ Add people outside the team");
    expect(html).not.toContain("People outside the team</label>");
    expect(html).not.toContain("pat@acme.com, @acme.com");
  });

  it("states the format of outsiders in one line under their label", () => {
    const html = fireEditor({ mode: "people", people: [], withTeam: false, outsiders: "@acme.com" });
    expect(html).toContain("Addresses, @domains or phone numbers with the country code, separated by commas");
  });

  it("makes everyone on the team the first row of the member list, and covers the members while it is ticked", () => {
    const ticked = fireEditor({ mode: "people", people: [BOB], withTeam: true, outsiders: "" });
    const rows = ticked.slice(ticked.indexOf('data-testid="people-picker"')).split("<li");
    expect(rows[1]).toContain("Everyone on the team");
    // Bob's tick is kept under the team's, but he can no longer be changed.
    expect(rows[3]).toMatch(/title="Bob"/);
    expect(rows[3]).toMatch(/checked=""/);
    expect(rows[3]).toContain('disabled=""');
    expect(rows[3]).toContain("opacity-50");

    const open = fireEditor({ mode: "people", people: [BOB], withTeam: false, outsiders: "" });
    expect(open.slice(open.indexOf('data-testid="people-picker"')).split("<li")[3]).not.toContain('disabled=""');
  });

  it("keeps a long name and address to two lines, each cut short with the whole in a tooltip", () => {
    const name = "Maximiliana Featherstonehaugh-Worthington";
    const email = "maximiliana.featherstonehaugh-worthington@verylongcompanyname.example";
    const long: Member = { userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", username: name, email, access: "read" };
    const html = fireEditor({ mode: "people", people: [], withTeam: false, outsiders: "" }, [...members, long]);
    expect(html).toContain(`<span class="block truncate" title="${name}">${name}</span>`);
    expect(html).toContain(`title="${email} \u00b7 reads only"`);
    expect(html).toContain("items-start");
  });

  it("lets a long outsider that cannot be read wrap instead of overflowing the dialog", () => {
    const html = fireEditor({ mode: "people", people: [], withTeam: false, outsiders: "notanaddressatallbutaverylongwordwithnospaces" });
    expect(html).toContain("break-words text-[11.5px] text-red-600");
  });

  it("cuts a long phrase short inside its chip, with the whole in a tooltip", () => {
    const email = "maximiliana.featherstonehaugh-worthington@verylongcompanyname.example";
    const html = panel({
      listing: { ...readerListing(), lists: { read: [{ kind: "email", address: email }], write: [], fire: [] } },
    });
    expect(html).toMatch(new RegExp(`title="${email}"[^>]*class="max-w-full truncate`));
  });
});

describe("the app's own messages", () => {
  const slack = { id: "c0000000-0000-4000-8000-000000000001", name: "Team Slack" };
  const withLines = (...dropsOwnMessages: DropsOwnMessagesLine[]) => panel({ listing: { ...readerListing(), dropsOwnMessages } });
  const inFireList = (html: string) => html.slice(html.indexOf('data-testid="access-fire"'));

  it("says a Slack connection drops the app's own messages and reactions, in the fire list, and offers to turn it off", () => {
    const html = withLines({ on: true, mayChange: true, connection: slack });
    const fire = inFireList(html);
    expect(fire).toContain('data-testid="access-drops-own-messages"');
    expect(fire).toContain(DROPS_OWN_MESSAGES);
    expect(fire).toContain("Team Slack");
    expect(fire).toContain("Turn off");
    expect(html.slice(0, html.indexOf('data-testid="access-fire"'))).not.toContain("access-drops-own-messages");
  });

  it("offers to turn it back on once it is off", () => {
    const fire = inFireList(withLines({ on: false, mayChange: true, connection: slack }));
    expect(fire).toContain(HEARS_OWN_MESSAGES);
    expect(fire).not.toContain(DROPS_OWN_MESSAGES);
    expect(fire).toContain("Turn on");
  });

  it("shows the line alone to someone who may not change the connection, naming it only if they may use it", () => {
    const read = inFireList(withLines({ on: true, mayChange: false, connection: slack }));
    expect(read).toContain(DROPS_OWN_MESSAGES);
    expect(read).not.toContain("access-drops-own-messages-toggle");

    const unseen = inFireList(withLines({ on: true, mayChange: false, connection: null }));
    expect(unseen).toContain(DROPS_OWN_MESSAGES);
    expect(unseen).not.toContain("Team Slack");
    expect(unseen).not.toContain("access-drops-own-messages-toggle");
  });

  it("shows one line for each connection the automation listens on", () => {
    const other = { id: "c0000000-0000-4000-8000-000000000002", name: "Ops Slack" };
    const html = withLines({ on: true, mayChange: true, connection: slack }, { on: false, mayChange: true, connection: other });
    expect(html.split('data-testid="access-drops-own-messages"')).toHaveLength(3);
  });

  it("shows nothing for an automation that listens on no such connection, and says why a change was not made", () => {
    expect(panel({})).not.toContain("access-drops-own-messages");
    expect(panel({ settingError: "Couldn't save the change." })).toContain('data-testid="access-setting-error"');
  });
});

describe("the choice at creation", () => {
  it("asks who may see and change it and who may set it off, with nothing chosen", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationAccessChoice, { choice: NO_AUTOMATION_CHOICE, onChange: noop, members, viewerUserId: ME }),
    );
    expect(html).toContain("Who may see and change it");
    expect(html).toContain("Who may set it off");
    // One dropdown per question, each reading "Choose…" until the person picks, with no hint paragraph beside it.
    expect(html.match(/Choose…/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Who may see and change it"');
    expect(html).toContain('aria-label="Who may set it off"');
    expect(html).toContain('data-testid="choice-see"');
    expect(html).toContain('data-testid="choice-fire"');
    expect(html).not.toContain("Nobody else on the team.");
  });

  it("shows the chosen answer's description under its closed dropdown", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationAccessChoice, {
        choice: { ...NO_AUTOMATION_CHOICE, see: "team", fire: "anyone" },
        onChange: noop,
        members,
        viewerUserId: ME,
      }),
    );
    expect(html).toContain("Whole team");
    expect(html).toContain("Everyone on the team now, and whoever joins. Members who only read can see it but not change it.");
    expect(html).toContain("Anyone who can message, email or trigger its listens. Its own filters still apply.");
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
    lists: { read: [{ kind: "user", userId: ME, name: "Me", email: null, onTeam: true }], write: [{ kind: "user", userId: BOB, name: "Bob", email: null, onTeam: true }], fire: [{ kind: "team" }] },
    mayChange: true,
    onlyYou: false,
    viewerUserId: ME,
    carriedPin: false,
    teamRunsOnLf: false,
    dropsOwnMessages: [],
  };
}

describe("when the panel's lists could not be read", () => {
  it("says so, so a missing panel is not mistaken for an unrestricted thing", () => {
    const html = renderToStaticMarkup(createElement(AccessLoadFailed, { thing: "connection" }));
    expect(html).toContain('data-testid="access-load-failed"');
    expect(html).toContain("Couldn&#x27;t load who may reach this connection.");
  });
});
