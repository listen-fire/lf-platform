"use client";

// Asking who may reach a thing as it is created. Every web path that creates
// an automation or a connection asks, with nothing chosen for the person, and
// sends what they chose in the creating call; until they choose, it cannot be
// created.

import { useCallback, useState, type ReactNode } from "react";

import { Modal } from "@/components/ontology/modal";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui";

import { useTeamMembers } from "./access-panel";
import { AutomationAccessChoice, ConnectionAccessChoice } from "./choice";
import {
  NO_AUTOMATION_CHOICE,
  NO_CONNECTION_CHOICE,
  automationStatements,
  connectionUse,
  fireOptionsFor,
  type AutomationChoice,
  type AutomationVerb,
  type ConnectionChoice,
  type Grantee,
} from "./grantees";

const LOADING = <p className="text-[12px] text-gray-400">Loading the team…</p>;

/**
 * Who may use a connection about to be created: the field to show, and the
 * use list once the person has chosen (null until then).
 */
export function useConnectionUseChoice(options: { enabled: boolean }): {
  use: Grantee[] | null;
  field: ReactNode;
  reset: () => void;
} {
  const team = useTeamMembers(options);
  const [choice, setChoice] = useState<ConnectionChoice>(NO_CONNECTION_CHOICE);
  const reset = useCallback(() => setChoice(NO_CONNECTION_CHOICE), []);
  if (team.viewerUserId === null || team.members === null) return { use: null, field: LOADING, reset };
  const chooser = { viewerUserId: team.viewerUserId, members: team.members };
  return {
    use: connectionUse(choice, chooser),
    field: <ConnectionAccessChoice choice={choice} onChange={setChoice} members={team.members} viewerUserId={team.viewerUserId} />,
    reset,
  };
}

/** Before a new automation's first save: who may see and change it, and who may set it off. */
export function CreateAutomationDialog({
  isOpen,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: (statements: Record<AutomationVerb, Grantee[]>) => void;
}) {
  const team = useTeamMembers({ enabled: isOpen });
  const engine = trpc.views.teamEngine.get.useQuery(undefined, { enabled: isOpen, refetchOnWindowFocus: false });
  const [choice, setChoice] = useState<AutomationChoice>(NO_AUTOMATION_CHOICE);
  const statements =
    team.viewerUserId === null || team.members === null
      ? null
      : automationStatements(choice, { viewerUserId: team.viewerUserId, members: team.members });
  const close = () => {
    setChoice(NO_AUTOMATION_CHOICE);
    onCancel();
  };
  return (
    <Modal isOpen={isOpen} onClose={close} title="Who may reach this automation">
      <div className="p-5" data-testid="create-automation-dialog">
        {team.viewerUserId === null || team.members === null || engine.data === undefined ? (
          LOADING
        ) : (
          <AutomationAccessChoice
            choice={choice}
            onChange={setChoice}
            members={team.members}
            viewerUserId={team.viewerUserId}
            fireOptions={fireOptionsFor(engine.data.engine, { outsiders: false, carriedPin: false })}
          />
        )}
        <p className="mt-4 text-[11.5px] leading-relaxed text-gray-400">
          You can change these later on the automation&apos;s page, under Access.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3.5">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={statements === null}
          data-testid="create-automation-confirm"
          onClick={() => {
            if (statements === null) return;
            setChoice(NO_AUTOMATION_CHOICE);
            onConfirm(statements);
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}

/** Who may use a connection a flow outside a form is about to create (the editor's connect action). */
export function ChooseUseDialog({
  isOpen,
  title,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: (use: Grantee[]) => void;
}) {
  const { use, field, reset } = useConnectionUseChoice({ enabled: isOpen });
  const close = () => {
    reset();
    onCancel();
  };
  return (
    <Modal isOpen={isOpen} onClose={close} title={title}>
      <div className="p-5" data-testid="choose-use-dialog">
        {field}
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3.5">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={use === null}
          onClick={() => {
            if (use === null) return;
            reset();
            onConfirm(use);
          }}
        >
          Continue
        </Button>
      </div>
    </Modal>
  );
}
