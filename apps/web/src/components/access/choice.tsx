"use client";

// The choices a person makes about who may reach a thing: as they create it
// (nothing chosen until they choose), and as they change one of its lists.
// Drawn from props alone, so the pages own the queries.

import {
  FIRE_OPTIONS,
  SEE_OPTIONS,
  USE_OPTIONS,
  type AutomationChoice,
  type ConnectionChoice,
  type ListDraft,
  type Member,
  type Verb,
  takesOutsiders,
  unreadableOutsiders,
} from "./grantees";

export function RadioGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  /** Null until the person chooses: no option is ever chosen for them. */
  value: T | null;
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            className={`cursor-pointer rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
              checked
                ? "border-primary bg-primary-50 text-primary-700"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Members to tick. The viewer, when `viewerAlways`, is shown on and cannot be taken off. */
export function PeoplePicker({
  members,
  chosen,
  onChange,
  viewerUserId,
  viewerAlways,
  writersOnly,
}: {
  members: readonly Member[];
  chosen: readonly string[];
  onChange: (chosen: string[]) => void;
  viewerUserId: string;
  viewerAlways: boolean;
  /** Offer only members who may write on the team (a write list names no one else). */
  writersOnly?: boolean;
}) {
  const offered = members.filter((m) => !writersOnly || m.access === "write");
  if (offered.length === 0) {
    return <p className="text-[12px] text-gray-400">Nobody on the team yet.</p>;
  }
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-gray-100 px-2.5 py-2" data-testid="people-picker">
      {offered.map((member) => {
        const isViewer = member.userId === viewerUserId;
        const locked = isViewer && viewerAlways;
        const checked = locked || chosen.includes(member.userId);
        return (
          <li key={member.userId}>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-gray-700">
              <input
                type="checkbox"
                checked={checked}
                disabled={locked}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...chosen, member.userId]
                      : chosen.filter((id) => id !== member.userId),
                  )
                }
              />
              <span>{isViewer ? "You" : member.username}</span>
              {member.email && !isViewer && <span className="text-gray-400">{member.email}</span>}
              {member.access === "read" && <span className="text-[11px] text-gray-400">(reads only)</span>}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function Question({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] font-medium text-gray-700">{title}</div>
      {hint && <p className="text-[11.5px] leading-relaxed text-gray-400">{hint}</p>}
      {children}
    </div>
  );
}

/** Who may see and change a new automation, and who may set it off. */
export function AutomationAccessChoice({
  choice,
  onChange,
  members,
  viewerUserId,
}: {
  choice: AutomationChoice;
  onChange: (choice: AutomationChoice) => void;
  members: readonly Member[];
  viewerUserId: string;
}) {
  return (
    <div className="space-y-4" data-testid="automation-access-choice">
      <Question
        title="Who may see and change it"
        hint="People who may only read on the team can see it but not change it."
      >
        <RadioGroup
          label="Who may see and change it"
          options={SEE_OPTIONS}
          value={choice.see}
          onChange={(see) => onChange({ ...choice, see })}
          testId="choice-see"
        />
        {choice.see === "people" && (
          <PeoplePicker
            members={members}
            chosen={choice.seePeople}
            onChange={(seePeople) => onChange({ ...choice, seePeople })}
            viewerUserId={viewerUserId}
            viewerAlways
          />
        )}
      </Question>
      <Question title="Who may set it off" hint="Through its listens: a message, an email, an event from a connected system.">
        <RadioGroup
          label="Who may set it off"
          options={FIRE_OPTIONS}
          value={choice.fire}
          onChange={(fire) => onChange({ ...choice, fire })}
          testId="choice-fire"
        />
        {choice.fire === "people" && (
          <PeoplePicker
            members={members}
            chosen={choice.firePeople}
            onChange={(firePeople) => onChange({ ...choice, firePeople })}
            viewerUserId={viewerUserId}
            viewerAlways={false}
          />
        )}
      </Question>
    </div>
  );
}

/** Who may use a new connection. */
export function ConnectionAccessChoice({
  choice,
  onChange,
  members,
  viewerUserId,
}: {
  choice: ConnectionChoice;
  onChange: (choice: ConnectionChoice) => void;
  members: readonly Member[];
  viewerUserId: string;
}) {
  return (
    <div data-testid="connection-access-choice">
      <Question
        title="Who may use it"
        hint="Whoever may use it can run automations on it, read through it, and change who else may."
      >
        <RadioGroup
          label="Who may use it"
          options={USE_OPTIONS}
          value={choice.use}
          onChange={(use) => onChange({ ...choice, use })}
          testId="choice-use"
        />
        {choice.use === "people" && (
          <PeoplePicker
            members={members}
            chosen={choice.usePeople}
            onChange={(usePeople) => onChange({ ...choice, usePeople })}
            viewerUserId={viewerUserId}
            viewerAlways
          />
        )}
      </Question>
    </div>
  );
}

const DRAFT_OPTIONS: Record<Verb, readonly { value: ListDraft["mode"]; label: string }[]> = {
  read: SEE_OPTIONS,
  write: SEE_OPTIONS,
  use: USE_OPTIONS,
  fire: FIRE_OPTIONS,
};

/** One list being changed: the same choices as at creation, opened on the list as it stands. */
export function ListEditor({
  verb,
  draft,
  onChange,
  members,
  viewerUserId,
}: {
  verb: Verb;
  draft: ListDraft;
  onChange: (draft: ListDraft) => void;
  members: readonly Member[];
  viewerUserId: string;
}) {
  const outsiders = takesOutsiders(verb);
  const unreadable = unreadableOutsiders(draft.outsiders);
  return (
    <div className="space-y-2" data-testid={`list-editor-${verb}`}>
      <RadioGroup
        label={`Who may ${verb}`}
        options={DRAFT_OPTIONS[verb]}
        value={draft.mode}
        onChange={(mode) => onChange({ ...draft, mode })}
      />
      {draft.mode === "people" && (
        <>
          {outsiders && (
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-gray-700">
              <input
                type="checkbox"
                checked={draft.withTeam}
                onChange={(e) => onChange({ ...draft, withTeam: e.target.checked })}
              />
              Everyone on the team
            </label>
          )}
          <PeoplePicker
            members={members}
            chosen={draft.people}
            onChange={(people) => onChange({ ...draft, people })}
            viewerUserId={viewerUserId}
            viewerAlways={false}
            writersOnly={verb === "write"}
          />
          {outsiders && (
            <div>
              <label className="mb-1 block text-[11.5px] text-gray-500">
                People outside the team: addresses, domains (@acme.com) or phone numbers with the country code, separated by commas
              </label>
              <textarea
                value={draft.outsiders}
                onChange={(e) => onChange({ ...draft, outsiders: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-[12px] focus:border-gray-400 focus:outline-none"
                placeholder="pat@acme.com, @acme.com, +44 7700 900123"
              />
              {unreadable.length > 0 && (
                <p className="mt-1 text-[11.5px] text-red-600">
                  Not an address, a domain or a phone number: {unreadable.join(", ")}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
