"use client";

// Who may reach one automation (read, write, fire) or one connection (use),
// drawn from props alone. Whoever may change the lists gets an edit control
// on each; anyone else sees them read-only. "Only you can see this" says when
// the lists that let someone see the thing admit the viewer alone.

import { Lock, Pencil } from "lucide-react";

import { Badge, Button } from "@/components/ui";

import { ListEditor } from "./choice";
import {
  departedOn,
  listOfDraft,
  listPhrases,
  unreadableOutsiders,
  type ListDraft,
  type ListedGrantee,
  type Member,
  type Verb,
} from "./grantees";

export type Thing = "automation" | "connection";

export const ONLY_YOU = "Only you can see this";

const VERBS: Record<Thing, readonly Verb[]> = {
  automation: ["read", "write", "fire"],
  connection: ["use"],
};

const TITLES: Record<Verb, { title: string; hint: string }> = {
  read: { title: "Read", hint: "Who may see it. Whoever may change it may also see it." },
  write: { title: "Write", hint: "Who may change, run and delete it, and change these lists." },
  fire: { title: "Fire", hint: "Who may set it off through its listens." },
  use: { title: "Use", hint: "Who may run automations on it, read through it, and change this list." },
};

/** What the server says about the thing's lists. */
export interface AccessListing {
  thing: Thing;
  lists: Partial<Record<Verb, readonly ListedGrantee[]>>;
  mayChange: boolean;
  onlyYou: boolean;
  viewerUserId: string | null;
}

export interface AccessPanelViewProps {
  listing: AccessListing;
  /** The list being changed, if any. */
  editing: { verb: Verb; draft: ListDraft } | null;
  /** The team, to choose people from; null until it has loaded. */
  members: readonly Member[] | null;
  /** The engine the team's automations run on, which decides who may be chosen to fire; null until it has loaded. */
  engine: "platform" | "lf" | null;
  busy: boolean;
  error: string | null;
  onEdit: (verb: Verb) => void;
  onDraft: (draft: ListDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** What the panel shows when its lists could not be read, so a missing panel is never mistaken for an unrestricted thing. */
export function AccessLoadFailed({ thing }: { thing: Thing }) {
  return (
    <p className="text-[12px] text-red-600" data-testid="access-load-failed">
      Couldn&apos;t load who may reach this {thing}. Reload the page to try again.
    </p>
  );
}

export function AccessPanelView(props: AccessPanelViewProps) {
  const { listing, editing } = props;
  const viewer = listing.viewerUserId;
  return (
    <section data-testid="access-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">Access</h2>
        {listing.onlyYou && (
          <Badge tone="amber" testId="access-only-you">
            <Lock size={10} />
            {ONLY_YOU}
          </Badge>
        )}
      </div>
      <ul className="space-y-3">
        {VERBS[listing.thing].map((verb) => {
          const list = listing.lists[verb] ?? [];
          const isEditing = editing?.verb === verb;
          return (
            <li key={verb} className="rounded-lg border border-gray-100 px-3 py-2.5" data-testid={`access-${verb}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] font-medium text-gray-800">{TITLES[verb].title}</div>
                  <div className="text-[11.5px] leading-relaxed text-gray-400">{TITLES[verb].hint}</div>
                </div>
                {listing.mayChange && !isEditing && editing === null && (
                  <button
                    type="button"
                    onClick={() => props.onEdit(verb)}
                    className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                    data-testid={`access-edit-${verb}`}
                  >
                    <Pencil size={11} />
                    Change
                  </button>
                )}
              </div>
              {isEditing && viewer !== null ? (
                <EditingList {...props} verb={verb} draft={editing.draft} viewerUserId={viewer} />
              ) : (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {list.length === 0 ? (
                    <span className="text-[12px] text-gray-400">Nobody yet</span>
                  ) : (
                    listPhrases(list, viewer).map((phrase, i) => (
                      <span
                        key={`${phrase}${i}`}
                        title={phrase}
                        className="max-w-full truncate rounded-full bg-gray-100 px-2 py-0.5 text-[11.5px] text-gray-700"
                      >
                        {phrase}
                      </span>
                    ))
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!listing.mayChange && (
        <p className="mt-2 text-[11.5px] text-gray-400" data-testid="access-read-only">
          {listing.thing === "automation"
            ? "Only someone who may change this automation, or a team admin, can change who may reach it."
            : "Only someone who may use this connection, with write access on the team, or a team admin, can change who may."}
        </p>
      )}
    </section>
  );
}

function EditingList(props: AccessPanelViewProps & { verb: Verb; draft: ListDraft; viewerUserId: string }) {
  const { verb, draft, viewerUserId } = props;
  const stated = listOfDraft(draft, { verb, viewerUserId });
  const savable = stated.length > 0 && unreadableOutsiders(draft.outsiders).length === 0;
  const departed = departedOn(props.listing.lists[verb] ?? []);
  return (
    <div className="mt-2 space-y-2">
      {props.members === null || props.engine === null ? (
        <p className="text-[12px] text-gray-400">Loading the team…</p>
      ) : (
        <ListEditor
          verb={verb}
          draft={draft}
          onChange={props.onDraft}
          members={props.members}
          viewerUserId={viewerUserId}
          engine={props.engine}
        />
      )}
      {departed > 0 && (
        <p className="text-[11.5px] text-gray-500" data-testid="access-departed">
          {departed === 1 ? "Someone on this list has left the team, and" : `${departed} people on this list have left the team, and`} saving
          leaves them off.
        </p>
      )}
      {props.error && <p className="text-[12px] text-red-600" data-testid="access-error">{props.error}</p>}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={props.onSave} disabled={!savable || props.busy} data-testid="access-save">
          {props.busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        {stated.length === 0 && <span className="text-[11.5px] text-gray-400">A list can&apos;t be empty.</span>}
      </div>
    </div>
  );
}
