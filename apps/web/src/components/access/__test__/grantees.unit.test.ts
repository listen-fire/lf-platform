import {
  NO_AUTOMATION_CHOICE,
  NO_CONNECTION_CHOICE,
  SEE_OPTIONS,
  USE_OPTIONS,
  automationStatements,
  connectionUse,
  departedOn,
  draftOf,
  listRefusalSentence,
  listOfDraft,
  listPhrases,
  type ListDraft,
  managesTeam,
  writesOnTeam,
  type ListedGrantee,
  type Member,
} from "../grantees";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAROL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const members: Member[] = [
  { userId: ME, username: "Me", email: "me@acme.com", access: "write" },
  { userId: BOB, username: "Bob", email: "bob@acme.com", access: "write" },
  { userId: CAROL, username: "Carol", email: "carol@acme.com", access: "read" },
];
const chooser = { viewerUserId: ME, members };

describe("a list in plain words", () => {
  it("says Whole team, Only you, each person by name, and each person by name", () => {
    expect(listPhrases([{ kind: "team" }], ME)).toEqual(["Whole team"]);
    expect(listPhrases([{ kind: "user", userId: ME, name: "Me", email: null, onTeam: true }], ME)).toEqual(["Only you"]);
    expect(
      listPhrases(
        [
          { kind: "user", userId: ME, name: "Me", email: null, onTeam: true },
          { kind: "user", userId: BOB, name: "Bob", email: "bob@acme.com", onTeam: true },
          // She left: her name is still on file, and the list does not show it.
          { kind: "user", userId: CAROL, name: "Carol", email: "carol@acme.com", onTeam: false },
        ],
        ME,
      ),
    ).toEqual(["You", "Bob", "Someone no longer on the team"]);
  });
});

describe("the choices offered", () => {
  it("describes every choice in one line, so each can be told apart without a hint beside the question", () => {
    for (const option of [...SEE_OPTIONS, ...USE_OPTIONS]) expect(option.description).not.toBe("");
  });

  it("offers no choice about setting an automation off", () => {
    expect([...SEE_OPTIONS, ...USE_OPTIONS].map((o) => o.value)).toEqual(["me", "team", "people", "me", "team", "people"]);
  });
});

describe("choosing at creation", () => {
  it("makes nothing until the choice is made, and nothing is chosen to begin with", () => {
    expect(NO_AUTOMATION_CHOICE).toEqual({ see: null, seePeople: [] });
    expect(automationStatements(NO_AUTOMATION_CHOICE, chooser)).toBeNull();
    expect(connectionUse(NO_CONNECTION_CHOICE, chooser)).toBeNull();
  });

  it("sets read and write from the one choice, and nothing else", () => {
    expect(automationStatements({ ...NO_AUTOMATION_CHOICE, see: "me" }, chooser)).toEqual({
      read: [{ kind: "user", userId: ME }],
      write: [{ kind: "user", userId: ME }],
    });
    expect(automationStatements({ ...NO_AUTOMATION_CHOICE, see: "team" }, chooser)).toEqual({
      read: [{ kind: "team" }],
      write: [{ kind: "team" }],
    });
  });

  it("puts specific people on the read list, those who may write on the team on the write list, and the creator on both", () => {
    expect(
      automationStatements({ see: "people", seePeople: [BOB, CAROL] }, chooser),
    ).toEqual({
      read: [{ kind: "user", userId: ME }, { kind: "user", userId: BOB }, { kind: "user", userId: CAROL }],
      write: [{ kind: "user", userId: ME }, { kind: "user", userId: BOB }],
    });
  });

  it("counts a team admin as someone who may write, so they go on the write list too", () => {
    const DANA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const withAdmin = { viewerUserId: ME, members: [...members, { userId: DANA, username: "Dana", email: "dana@acme.com", access: "admin" as const }] };
    expect(automationStatements({ see: "people", seePeople: [DANA, CAROL] }, withAdmin)?.write).toEqual([
      { kind: "user", userId: ME },
      { kind: "user", userId: DANA },
    ]);
    expect([writesOnTeam("admin"), writesOnTeam("write"), writesOnTeam("read")]).toEqual([true, true, false]);
  });

  it("offers team management to an admin alone", () => {
    expect([managesTeam("admin"), managesTeam("write"), managesTeam("read")]).toEqual([true, false, false]);
  });

  it("always puts the creator on a new connection's use list", () => {
    expect(connectionUse({ use: "people", usePeople: [BOB] }, chooser)).toEqual([
      { kind: "user", userId: ME },
      { kind: "user", userId: BOB },
    ]);
    expect(connectionUse({ use: "me", usePeople: [] }, chooser)).toEqual([{ kind: "user", userId: ME }]);
    expect(connectionUse({ use: "team", usePeople: [] }, chooser)).toEqual([{ kind: "team" }]);
  });
});

describe("changing a list", () => {
  it("opens on the list as it stands and gives back the same list", () => {
    const lists: ListedGrantee[][] = [
      [{ kind: "team" }],
      [{ kind: "user", userId: ME, name: "Me", email: null, onTeam: true }],
      [
        { kind: "user", userId: ME, name: "Me", email: null, onTeam: true },
        { kind: "user", userId: BOB, name: "Bob", email: null, onTeam: true },
      ],
    ];
    for (const list of lists) {
      const stated = listOfDraft(draftOf(list, ME), { viewerUserId: ME });
      expect(stated).toEqual(list.map((g) => (g.kind === "user" ? { kind: "user", userId: g.userId } : g)));
    }
  });

  it("leaves someone who has left the team off the draft, so saving it is not refused", () => {
    const list: ListedGrantee[] = [
      { kind: "user", userId: ME, name: "Me", email: null, onTeam: true },
      { kind: "user", userId: BOB, name: "Bob", email: null, onTeam: false },
    ];
    expect(draftOf(list, ME).mode).toBe("me");
    expect(departedOn(list)).toBe(1);
  });

  it("says each refusal of a changed list in the page's own words", () => {
    expect(listRefusalSentence("not_a_member", "automation")).toBe("Someone you chose is no longer on the team. Choose again.");
    expect(listRefusalSentence("not_allowed", "connection")).toContain("may use this connection");
    expect(listRefusalSentence("not_a_writer", "automation")).toContain("can only read");
  });

  it("opens a list naming the team beside people as the whole team, which loses nobody's access when saved", () => {
    const list: ListedGrantee[] = [{ kind: "team" }, { kind: "user", userId: BOB, name: "Bob", email: null, onTeam: true }];
    expect(draftOf(list, ME).mode).toBe("team");
    expect(listOfDraft(draftOf(list, ME), { viewerUserId: ME })).toEqual([{ kind: "team" }]);
  });

  it("names only the people ticked on a list", () => {
    const draft: ListDraft = { mode: "people", people: [BOB] };
    expect(listOfDraft(draft, { viewerUserId: ME })).toEqual([{ kind: "user", userId: BOB }]);
  });
});
