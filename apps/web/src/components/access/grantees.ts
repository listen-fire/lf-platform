// Who may reach an automation or a connection, as the page says it and as a
// person chooses it. An automation has three lists (read, write, fire) and a
// connection one (use); each names the whole team, people on it, or, for
// firing only, people outside it. These shapes are the server's
// (`services/access/statement.ts`); the server judges every value.

export type Grantee =
  | { kind: "team" }
  | { kind: "user"; userId: string }
  | { kind: "anyone" }
  | { kind: "domain"; domain: string }
  | { kind: "email"; address: string }
  | { kind: "phone"; digits: string };

/** A list entry as the server shows it: a named user comes with who they are, and whether they are still on the team. */
export type ListedGrantee =
  | Exclude<Grantee, { kind: "user" }>
  | { kind: "user"; userId: string; name: string | null; email: string | null; onTeam: boolean };

export type AutomationVerb = "read" | "write" | "fire";
export type Verb = AutomationVerb | "use";

/** A member's level on the team: each holds everything the one below it does. */
export type TeamAccess = "read" | "write" | "admin";

/** Whether a member at this level may write on the team, and so hold a write list. */
export function writesOnTeam(access: TeamAccess): boolean {
  switch (access) {
    case "read":
      return false;
    case "write":
    case "admin":
      return true;
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
}

/** Whether a member at this level is a team admin, whom the server lets manage the team. */
export function managesTeam(access: TeamAccess): boolean {
  switch (access) {
    case "read":
    case "write":
      return false;
    case "admin":
      return true;
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
}

/** Someone on the team, as the team page lists them. */
export interface Member {
  userId: string;
  username: string;
  email: string | null;
  access: TeamAccess;
}

/** Who is choosing: the lists name them as "you". */
export interface Chooser {
  viewerUserId: string;
  members: readonly Member[];
}

/** A list in plain words, one phrase per entry. A list of only the viewer is "Only you". */
export function listPhrases(list: readonly ListedGrantee[], viewerUserId: string | null): string[] {
  const [only] = list;
  if (list.length === 1 && only?.kind === "user" && only.userId === viewerUserId) return ["Only you"];
  return list.map((grantee) => granteePhrase(grantee, viewerUserId));
}

export function granteePhrase(grantee: ListedGrantee, viewerUserId: string | null): string {
  switch (grantee.kind) {
    case "team":
      return "Whole team";
    case "user":
      if (grantee.userId === viewerUserId) return "You";
      // Someone who left keeps their account and name on file; the list says they are gone rather than naming them.
      if (!grantee.onTeam) return "Someone no longer on the team";
      return grantee.name ?? grantee.email ?? "Someone no longer on the team";
    case "anyone":
      return "Anyone";
    case "domain":
      return `Anyone at @${grantee.domain}`;
    case "email":
      return grantee.address;
    case "phone":
      return `+${grantee.digits}`;
    default: {
      const unreachable: never = grantee;
      return unreachable;
    }
  }
}

// ── Choosing at creation ────────────────────────────────────────────────────

/** Who may see and change a new automation: one choice sets both its read and write lists. */
export type SeeChoice = "me" | "team" | "people";
/** Who may set a new automation off. */
export type FireChoice = "me" | "team" | "anyone" | "people";
/** Who may use a new connection. */
export type UseChoice = "me" | "team" | "people";

/** A creation choice in progress: nothing is chosen until the person chooses it. */
export interface AutomationChoice {
  see: SeeChoice | null;
  seePeople: readonly string[];
  fire: FireChoice | null;
  firePeople: readonly string[];
}

export interface ConnectionChoice {
  use: UseChoice | null;
  usePeople: readonly string[];
}

export const NO_AUTOMATION_CHOICE: AutomationChoice = { see: null, seePeople: [], fire: null, firePeople: [] };
export const NO_CONNECTION_CHOICE: ConnectionChoice = { use: null, usePeople: [] };

/** One answer to a question about who may reach a thing, and what choosing it means. */
export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

const ONLY_ME = "Nobody else on the team.";
const WHOLE_TEAM = "Everyone on the team now, and whoever joins.";

export const SEE_OPTIONS: readonly ChoiceOption<SeeChoice>[] = [
  { value: "me", label: "Only me", description: ONLY_ME },
  { value: "team", label: "Whole team", description: `${WHOLE_TEAM} Members who only read can see it but not change it.` },
  { value: "people", label: "Specific people", description: "Pick people on the team." },
];

export const USE_OPTIONS: readonly ChoiceOption<UseChoice>[] = [
  { value: "me", label: "Only me", description: ONLY_ME },
  { value: "team", label: "Whole team", description: WHOLE_TEAM },
  { value: "people", label: "Specific people", description: "Pick people on the team." },
];

const FIRE_OPTIONS: readonly ChoiceOption<FireChoice>[] = [
  { value: "me", label: "Only me", description: ONLY_ME },
  { value: "team", label: "Whole team", description: WHOLE_TEAM },
  {
    value: "anyone",
    label: "Anyone who reaches it",
    description: "Anyone who can message, email or trigger its listens. Its own filters still apply.",
  },
  { value: "people", label: "Specific people", description: "Pick people on the team." },
];

/**
 * Who may set a new automation off that the team's engine can keep to. On lf
 * the platform does not judge the door, so the server refuses any fire list
 * but "anyone" there; offering the rest would only invite a refusal. Whether
 * people outside the team can be named depends on where the choice is made:
 * the list editor takes them, the creation dialog does not.
 */
export function fireOptionsFor(engine: "platform" | "lf", options: { outsiders: boolean }): readonly ChoiceOption<FireChoice>[] {
  switch (engine) {
    case "platform":
      return options.outsiders
        ? FIRE_OPTIONS.map((o) => (o.value === "people" ? { ...o, description: "Pick people on the team, or outside it." } : o))
        : FIRE_OPTIONS;
    case "lf":
      return FIRE_OPTIONS.filter((option) => option.value === "anyone");
    default: {
      const unreachable: never = engine;
      return unreachable;
    }
  }
}

const user = (userId: string): Grantee => ({ kind: "user", userId });

/** The viewer and the people chosen, once each, the viewer first. */
function withViewer(viewerUserId: string, people: readonly string[]): string[] {
  return [...new Set([viewerUserId, ...people])];
}

/**
 * The read, write and fire lists a new automation is created with, or null
 * until both choices are made. Choosing people for "see and change" puts
 * them all on the read list and those who may write on the team on the write
 * list too; the creator is always on both, since nobody creates what they
 * could not change.
 */
export function automationStatements(
  choice: AutomationChoice,
  chooser: Chooser,
): Record<AutomationVerb, Grantee[]> | null {
  const { viewerUserId, members } = chooser;
  let read: Grantee[];
  let write: Grantee[];
  switch (choice.see) {
    case null:
      return null;
    case "me":
      read = [user(viewerUserId)];
      write = [user(viewerUserId)];
      break;
    case "team":
      read = [{ kind: "team" }];
      write = [{ kind: "team" }];
      break;
    case "people": {
      const people = withViewer(viewerUserId, choice.seePeople);
      const writers = new Set(members.filter((m) => writesOnTeam(m.access)).map((m) => m.userId));
      read = people.map(user);
      write = people.filter((id) => id === viewerUserId || writers.has(id)).map(user);
      break;
    }
    default: {
      const unreachable: never = choice.see;
      return unreachable;
    }
  }
  let fire: Grantee[];
  switch (choice.fire) {
    case null:
      return null;
    case "me":
      fire = [user(viewerUserId)];
      break;
    case "team":
      fire = [{ kind: "team" }];
      break;
    case "anyone":
      fire = [{ kind: "anyone" }];
      break;
    case "people":
      if (choice.firePeople.length === 0) return null;
      fire = choice.firePeople.map(user);
      break;
    default: {
      const unreachable: never = choice.fire;
      return unreachable;
    }
  }
  return { read, write, fire };
}

/** The use list a new connection is created with, or null until it is chosen. The creator is always on it. */
export function connectionUse(choice: ConnectionChoice, chooser: Chooser): Grantee[] | null {
  switch (choice.use) {
    case null:
      return null;
    case "me":
      return [user(chooser.viewerUserId)];
    case "team":
      return [{ kind: "team" }];
    case "people":
      return withViewer(chooser.viewerUserId, choice.usePeople).map(user);
    default: {
      const unreachable: never = choice.use;
      return unreachable;
    }
  }
}

// ── Changing a list ─────────────────────────────────────────────────────────

/** One list being changed. People outside the team are firing's only. */
export interface ListDraft {
  mode: "me" | "team" | "anyone" | "people";
  /** In `people` mode: the members named. */
  people: readonly string[];
  /** In `people` mode, firing only: the whole team beside the people named. */
  withTeam: boolean;
  /** In `people` mode, firing only: addresses, domains and phone numbers, as typed. */
  outsiders: string;
}

/** Whether a verb's list may name people outside the team. */
export function takesOutsiders(verb: Verb): boolean {
  switch (verb) {
    case "fire":
      return true;
    case "read":
    case "write":
    case "use":
      return false;
    default: {
      const unreachable: never = verb;
      return unreachable;
    }
  }
}

function outsiderText(grantee: Grantee): string | undefined {
  switch (grantee.kind) {
    case "domain":
      return `@${grantee.domain}`;
    case "email":
      return grantee.address;
    case "phone":
      return `+${grantee.digits}`;
    case "team":
    case "user":
    case "anyone":
      return undefined;
    default: {
      const unreachable: never = grantee;
      return unreachable;
    }
  }
}

/**
 * A list as the editor opens on it. Someone who has left the team is left
 * off: the server refuses a list naming them, so keeping them would make
 * every save of it fail.
 */
export function draftOf(list: readonly ListedGrantee[], viewerUserId: string | null): ListDraft {
  const empty: ListDraft = { mode: "people", people: [], withTeam: false, outsiders: "" };
  if (list.some((g) => g.kind === "anyone")) return { ...empty, mode: "anyone" };
  const people = list.flatMap((g) => (g.kind === "user" && g.onTeam ? [g.userId] : []));
  const outsiders = list.flatMap((g) => outsiderText(g) ?? []);
  const withTeam = list.some((g) => g.kind === "team");
  // A list naming the whole team beside named people opens as "Whole team":
  // those people are on the team, so dropping their names when it is saved
  // loses nobody's access.
  if (withTeam && outsiders.length === 0) return { ...empty, mode: "team" };
  if (!withTeam && outsiders.length === 0 && people.length === 1 && people[0] === viewerUserId) return { ...empty, mode: "me" };
  return { mode: "people", people, withTeam, outsiders: outsiders.join(", ") };
}

/** How many on the list have left the team, whom the editor leaves off. */
export function departedOn(list: readonly ListedGrantee[]): number {
  return list.filter((g) => g.kind === "user" && !g.onTeam).length;
}

/** Why the server refused a changed list. The server's `StatementRefusal` (services/access/decide.ts). */
export type ListRefusal =
  | "empty"
  | "not_found"
  | "not_allowed"
  | "outsider"
  | "not_a_member"
  | "not_a_writer"
  | "malformed"
  | "lf_engine"
  | "already_stated";

/** Why a changed list was refused, in the page's words: the server's text is written for agents and is never shown. */
export function listRefusalSentence(refusal: ListRefusal, thing: "automation" | "connection"): string {
  switch (refusal) {
    case "empty":
      return "A list can't be empty: choose the whole team, or someone on it.";
    case "not_found":
      return `This ${thing} could not be found. Reload the page.`;
    case "not_allowed":
      return thing === "automation"
        ? "Only someone who may change this automation, or a team admin, can change who may reach it."
        : "Only someone who may use this connection, with write access on the team, or a team admin, can change who may.";
    case "outsider":
      return "People outside the team can only be allowed to set an automation off.";
    case "not_a_member":
      return "Someone you chose is no longer on the team. Choose again.";
    case "not_a_writer":
      return "Someone you chose can only read on your team, so they can't be allowed to change it. Choose again.";
    case "malformed":
      return "Something you chose could not be read. Check the addresses, domains and phone numbers.";
    case "lf_engine":
      return "Your team's automations run on lf, which does not check who sets one off, so only \u201cAnyone who reaches it\u201d can be chosen.";
    case "already_stated":
      return `This ${thing} already says who may reach it. Reload the page to see it.`;
    default: {
      const unreachable: never = refusal;
      return unreachable;
    }
  }
}

/**
 * Someone outside the team as a person writes them: an address, a domain
 * (with or without its @), or a phone number with its country code.
 */
export function outsiderOf(text: string): Grantee | null {
  const value = text.trim();
  if (value === "") return null;
  if (/^\+?[\d\s().-]+$/.test(value)) return { kind: "phone", digits: value.replace(/[^\d]/g, "") };
  const at = value.lastIndexOf("@");
  if (at > 0) return { kind: "email", address: value };
  const domain = at === 0 ? value.slice(1) : value;
  return domain.includes(".") ? { kind: "domain", domain } : null;
}

/** The entries of an outsiders field that are none of an address, a domain or a phone number. */
export function unreadableOutsiders(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && outsiderOf(part) === null);
}

/** The list a draft states, empty when it names nobody yet. */
export function listOfDraft(draft: ListDraft, options: { verb: Verb; viewerUserId: string }): Grantee[] {
  switch (draft.mode) {
    case "me":
      return [user(options.viewerUserId)];
    case "team":
      return [{ kind: "team" }];
    case "anyone":
      return takesOutsiders(options.verb) ? [{ kind: "anyone" }] : [];
    case "people": {
      const outside = takesOutsiders(options.verb)
        ? draft.outsiders.split(/[,\n]/).flatMap((part) => outsiderOf(part) ?? [])
        : [];
      const team: Grantee[] = draft.withTeam && takesOutsiders(options.verb) ? [{ kind: "team" }] : [];
      return [...team, ...draft.people.map(user), ...outside];
    }
    default: {
      const unreachable: never = draft.mode;
      return unreachable;
    }
  }
}
