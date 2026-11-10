"use client";

// The access panel on an automation's or a connection's page: reads the
// thing's lists, and changes one as the person chose it.

import { useState } from "react";

import { trpc, type RouterInputs } from "@/lib/trpc";

import { AccessLoadFailed, AccessPanelView, type AccessListing, type Thing } from "./access-panel-view";
import { draftOf, listOfDraft, type Grantee, type ListDraft, type Member, type Verb } from "./grantees";

type SetInput = RouterInputs["views"]["access"]["set"];

/** The change to send, when the verb is one the thing has. */
function setInputOf(target: { thing: Thing; id: string }, verb: Verb, grantees: Grantee[]): SetInput | null {
  switch (target.thing) {
    case "automation":
      return verb === "use" ? null : { thing: "automation", id: target.id, verb, grantees };
    case "connection":
      return verb === "use" ? { thing: "connection", id: target.id, verb, grantees } : null;
    default: {
      const unreachable: never = target.thing;
      return unreachable;
    }
  }
}

/** The team as the people pickers offer it. */
export function useTeamMembers(options: { enabled: boolean }): { viewerUserId: string | null; members: Member[] | null } {
  const overview = trpc.views.teamMembers.overview.useQuery(undefined, {
    enabled: options.enabled,
    refetchOnWindowFocus: false,
  });
  const data = overview.data;
  if (data === undefined) return { viewerUserId: null, members: null };
  return {
    viewerUserId: data.viewer.userId.toLowerCase(),
    members: data.members.map((m) => ({
      userId: m.userId.toLowerCase(),
      username: m.username,
      email: m.email,
      access: m.access,
    })),
  };
}

export function AccessPanel({ thing, id }: { thing: Thing; id: string }) {
  const utils = trpc.useUtils();
  const access = trpc.views.access.get.useQuery({ thing, id }, { refetchOnWindowFocus: false });
  const [editing, setEditing] = useState<{ verb: Verb; draft: ListDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const team = useTeamMembers({ enabled: editing !== null });
  const set = trpc.views.access.set.useMutation({
    onSuccess: (view) => {
      utils.views.access.get.setData({ thing, id }, view);
      void utils.views.movement.list.invalidate();
      void utils.views.connections.getAll.invalidate();
      setEditing(null);
      setError(null);
    },
    onError: (err) => setError(err.message),
  });

  if (access.isError) return <AccessLoadFailed thing={thing} />;
  if (access.data === undefined) return null;
  const view = access.data;
  const listing: AccessListing = {
    thing: view.thing,
    lists: view.lists,
    mayChange: view.mayChange,
    onlyYou: view.onlyYou,
    viewerUserId: view.viewerUserId,
  };

  return (
    <AccessPanelView
      listing={listing}
      editing={editing}
      members={team.members}
      busy={set.isLoading}
      error={error}
      onEdit={(verb) => {
        setError(null);
        setEditing({ verb, draft: draftOf(listing.lists[verb] ?? [], listing.viewerUserId) });
      }}
      onDraft={(draft) => setEditing((current) => (current === null ? null : { ...current, draft }))}
      onCancel={() => {
        setEditing(null);
        setError(null);
      }}
      onSave={() => {
        if (editing === null || listing.viewerUserId === null) return;
        const input = setInputOf({ thing, id }, editing.verb, listOfDraft(editing.draft, { verb: editing.verb, viewerUserId: listing.viewerUserId }));
        if (input !== null) set.mutate(input);
      }}
    />
  );
}
