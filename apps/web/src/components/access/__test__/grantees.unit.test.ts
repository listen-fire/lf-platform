import {
  NO_AUTOMATION_CHOICE,
  NO_CONNECTION_CHOICE,
  automationStatements,
  connectionUse,
  draftOf,
  listOfDraft,
  listPhrases,
  outsiderOf,
  unreadableOutsiders,
  type ListDraft,
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
  it("says Whole team, Only you, each person by name, and firing's outsiders as written", () => {
    expect(listPhrases([{ kind: "team" }], ME)).toEqual(["Whole team"]);
    expect(listPhrases([{ kind: "user", userId: ME, name: "Me", email: null }], ME)).toEqual(["Only you"]);
    expect(
      listPhrases(
        [
          { kind: "user", userId: ME, name: "Me", email: null },
          { kind: "user", userId: BOB, name: "Bob", email: "bob@acme.com" },
          { kind: "user", userId: CAROL, name: null, email: null },
        ],
        ME,
      ),
    ).toEqual(["You", "Bob", "Someone no longer on the team"]);
    expect(
      listPhrases(
        [
          { kind: "anyone" },
          { kind: "domain", domain: "acme.com" },
          { kind: "email", address: "pat@acme.com" },
          { kind: "phone", digits: "447700900123" },
        ],
        ME,
      ),
    ).toEqual(["Anyone", "Anyone at @acme.com", "pat@acme.com", "+447700900123"]);
  });
});

describe("choosing at creation", () => {
  it("makes nothing until both choices are made, and nothing is chosen to begin with", () => {
    expect(NO_AUTOMATION_CHOICE).toMatchObject({ see: null, fire: null });
    expect(automationStatements(NO_AUTOMATION_CHOICE, chooser)).toBeNull();
    expect(automationStatements({ ...NO_AUTOMATION_CHOICE, see: "team" }, chooser)).toBeNull();
    expect(automationStatements({ ...NO_AUTOMATION_CHOICE, fire: "anyone" }, chooser)).toBeNull();
    expect(connectionUse(NO_CONNECTION_CHOICE, chooser)).toBeNull();
  });

  it("sets read and write from one choice, and fire from the other", () => {
    expect(automationStatements({ ...NO_AUTOMATION_CHOICE, see: "me", fire: "anyone" }, chooser)).toEqual({
      read: [{ kind: "user", userId: ME }],
      write: [{ kind: "user", userId: ME }],
      fire: [{ kind: "anyone" }],
    });
    expect(automationStatements({ ...NO_AUTOMATION_CHOICE, see: "team", fire: "team" }, chooser)).toEqual({
      read: [{ kind: "team" }],
      write: [{ kind: "team" }],
      fire: [{ kind: "team" }],
    });
  });

  it("puts specific people on the read list, those who may write on the team on the write list, and the creator on both", () => {
    expect(
      automationStatements({ see: "people", seePeople: [BOB, CAROL], fire: "people", firePeople: [CAROL] }, chooser),
    ).toEqual({
      read: [{ kind: "user", userId: ME }, { kind: "user", userId: BOB }, { kind: "user", userId: CAROL }],
      write: [{ kind: "user", userId: ME }, { kind: "user", userId: BOB }],
      fire: [{ kind: "user", userId: CAROL }],
    });
  });

  it("waits for at least one person when specific people may set it off", () => {
    expect(automationStatements({ see: "me", seePeople: [], fire: "people", firePeople: [] }, chooser)).toBeNull();
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
      [{ kind: "user", userId: ME, name: "Me", email: null }],
      [{ kind: "anyone" }],
      [
        { kind: "team" },
        { kind: "domain", domain: "acme.com" },
        { kind: "email", address: "pat@acme.com" },
        { kind: "phone", digits: "447700900123" },
      ],
    ];
    for (const list of lists) {
      const stated = listOfDraft(draftOf(list, ME), { verb: "fire", viewerUserId: ME });
      expect(stated).toEqual(list.map((g) => (g.kind === "user" ? { kind: "user", userId: g.userId } : g)));
    }
  });

  it("names no outsider and no anyone on a list other than firing", () => {
    const draft: ListDraft = { mode: "people", people: [BOB], withTeam: true, outsiders: "pat@acme.com" };
    expect(listOfDraft(draft, { verb: "read", viewerUserId: ME })).toEqual([{ kind: "user", userId: BOB }]);
    expect(listOfDraft({ ...draft, mode: "anyone" }, { verb: "use", viewerUserId: ME })).toEqual([]);
  });

  it("reads people outside the team as they are written", () => {
    expect(outsiderOf("pat@acme.com")).toEqual({ kind: "email", address: "pat@acme.com" });
    expect(outsiderOf("@acme.com")).toEqual({ kind: "domain", domain: "acme.com" });
    expect(outsiderOf("acme.com")).toEqual({ kind: "domain", domain: "acme.com" });
    expect(outsiderOf("+44 7700 900123")).toEqual({ kind: "phone", digits: "447700900123" });
    expect(unreadableOutsiders("pat@acme.com, nobody, @acme.com")).toEqual(["nobody"]);
  });
});
