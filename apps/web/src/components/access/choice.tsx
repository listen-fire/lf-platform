"use client";

// The choices a person makes about who may reach a thing: as they create it
// (nothing chosen until they choose), and as they change one of its lists.
// Drawn from props alone, so the pages own the queries.

import { useEffect } from "react";

import { Select } from "@/components/select";

import {
  SEE_OPTIONS,
  USE_OPTIONS,
  type AutomationChoice,
  type ChoiceOption,
  type ConnectionChoice,
  type ListDraft,
  type Member,
  type Verb,
  writesOnTeam,
} from "./grantees";

/**
 * One question as a dropdown: each answer carries its own description, shown
 * in the open list, and the chosen one's stays under the closed dropdown. A
 * question with a single possible answer is stated rather than asked.
 */
export function ChoiceSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: readonly ChoiceOption<T>[];
  /** Null until the person chooses: no option is ever chosen for them. */
  value: T | null;
  onChange: (value: T) => void;
  testId?: string;
}) {
  const [only] = options.length === 1 ? options : [];
  // With nothing else to pick there is nothing to decide, so the answer is
  // taken here rather than left for a click on text that offers no click.
  useEffect(() => {
    if (only !== undefined && value !== only.value) onChange(only.value);
  }, [only, value, onChange]);

  if (only !== undefined) {
    return (
      <div data-testid={testId}>
        <div className="text-[13px] font-medium text-gray-900">{only.label}</div>
        <p className="mt-0.5 break-words text-[11.5px] leading-snug text-gray-400">{only.description}</p>
      </div>
    );
  }
  const chosen = options.find((option) => option.value === value);
  return (
    <div>
      <Select
        value={chosen?.value ?? ""}
        onChange={(picked) => {
          const option = options.find((o) => o.value === picked);
          if (option) onChange(option.value);
        }}
        options={options.map(({ value: v, label: l, description }) => ({ value: v, label: l, description }))}
        placeholder="Choose…"
        ariaLabel={label}
        testId={testId}
        searchable={false}
      />
      {chosen && <p className="mt-1 break-words text-[11.5px] leading-snug text-gray-400">{chosen.description}</p>}
    </div>
  );
}

/** What a member row says under the name: their address, and that they may only read. */
function memberDetail(member: Member, isViewer: boolean): string {
  return [isViewer ? null : member.email, member.access === "read" ? "reads only" : null].filter((part) => part !== null).join(" \u00b7 ");
}

/**
 * Members to tick. The viewer, when `viewerAlways`, is shown on and cannot be
 * taken off.
 */
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
  const offered = members.filter((m) => !writersOnly || writesOnTeam(m.access));
  if (offered.length === 0) {
    return <p className="text-[12px] text-gray-400">Nobody on the team yet.</p>;
  }
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border border-gray-100 px-2.5 py-2" data-testid="people-picker">
      {offered.map((member) => {
        const isViewer = member.userId === viewerUserId;
        const locked = isViewer && viewerAlways;
        const checked = locked || chosen.includes(member.userId);
        const name = isViewer ? "You" : member.username;
        const detail = memberDetail(member, isViewer);
        const email = isViewer ? null : (member.email ?? null);
        const readsOnly = member.access === "read";
        return (
          <li key={member.userId}>
            <label className="flex cursor-pointer items-start gap-2 text-[12px] text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
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
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={name}>
                  {name}
                </span>
                {detail !== "" && (
                  // The address gives way to "reads only", which must never be cut.
                  <span className="flex min-w-0 text-[11px] text-gray-400" title={detail}>
                    {email !== null && <span className="truncate">{email}</span>}
                    {readsOnly && <span className="shrink-0 whitespace-pre">{email !== null ? " · reads only" : "reads only"}</span>}
                  </span>
                )}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] font-medium text-gray-700">{title}</div>
      {children}
    </div>
  );
}

/** Who may see and change a new automation. */
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
      <Question title="Who may see and change it">
        <ChoiceSelect
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
      <Question title="Who may use it">
        <ChoiceSelect
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

const DRAFT_OPTIONS: Record<Verb, readonly ChoiceOption<ListDraft["mode"]>[]> = {
  read: SEE_OPTIONS,
  write: SEE_OPTIONS,
  use: USE_OPTIONS,
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
  return (
    <div className="space-y-2" data-testid={`list-editor-${verb}`}>
      <ChoiceSelect<ListDraft["mode"]>
        label={`Who may ${verb}`}
        options={DRAFT_OPTIONS[verb]}
        value={draft.mode}
        onChange={(mode) => onChange({ ...draft, mode })}
      />
      {draft.mode === "people" && (
        <PeoplePicker
          members={members}
          chosen={draft.people}
          onChange={(people) => onChange({ ...draft, people })}
          viewerUserId={viewerUserId}
          viewerAlways={false}
          writersOnly={verb === "write"}
        />
      )}
    </div>
  );
}
