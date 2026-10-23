/**
 * Where the team's automations run: on the platform, or in a cloud lf that
 * reads the team's movements from here. Switching either way takes a second
 * click, because each one stops one engine and hands the team to the other.
 * The card is drawn from props alone, so the page owns the queries.
 */

import { Button } from "@/components/ui";

import { Card } from "../card";

export type Engine = "platform" | "lf";

/** What each switch does, said before the second click. */
export const SWITCH_CONSEQUENCES: Record<Engine, string> = {
  lf:
    "The platform stops running this team's automations: every firing is dropped (the events are kept and can be replayed). A cloud lf must take over. Start it once this switch is a few seconds old.",
  platform:
    "Stop the cloud lf first. The platform starts running this team's automations again within a few seconds.",
};

const WHERE: Record<Engine, string> = {
  platform: "On the platform.",
  lf: "In a cloud lf, which reads this team's movements from here.",
};

const SWITCH_LABEL: Record<Engine, string> = {
  lf: "Switch to lf",
  platform: "Switch back to the platform",
};

export function otherEngine(engine: Engine): Engine {
  return engine === "platform" ? "lf" : "platform";
}

export interface EngineCardProps {
  engine: Engine;
  /** When it was last switched (ISO), and by whom; null when it never was. */
  changedAt: string | null;
  /** The member's name, or null for the operator CLI or someone no longer on the team. */
  changedByName: string | null;
  canWrite: boolean;
  /** The first click happened; the consequence is on screen awaiting the second. */
  confirming: boolean;
  busy: boolean;
  error: string | null;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function EngineCard(props: EngineCardProps) {
  const target = otherEngine(props.engine);
  return (
    <Card testId="team-engine">
      <p className="text-[13px] font-semibold text-slate-900">Where this team&apos;s automations run</p>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-500" data-testid="team-engine-current">
        {WHERE[props.engine]}
      </p>
      {props.changedAt !== null && (
        <p className="text-[11px] text-slate-400" data-testid="team-engine-changed">
          Switched {props.changedByName !== null ? `by ${props.changedByName} ` : ""}on{" "}
          {new Date(props.changedAt).toLocaleDateString()}.
        </p>
      )}
      {!props.canWrite ? (
        <p className="mt-3 text-[12px] text-slate-500" data-testid="team-engine-read-only">
          Only members with full access can switch it.
        </p>
      ) : props.confirming ? (
        <div className="mt-3" data-testid="team-engine-confirm">
          <p className="text-[12px] leading-relaxed text-slate-700" data-testid="team-engine-consequence">
            {SWITCH_CONSEQUENCES[target]}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={props.onConfirm}
              disabled={props.busy}
              data-testid="team-engine-confirm-yes"
            >
              {props.busy ? "Switching…" : SWITCH_LABEL[target]}
            </Button>
            <button
              onClick={props.onCancel}
              disabled={props.busy}
              className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={props.onAsk} data-testid="team-engine-switch">
            {SWITCH_LABEL[target]}
          </Button>
        </div>
      )}
      {props.error !== null && (
        <p className="mt-2 text-[12px] text-red-600" data-testid="team-engine-error">
          {props.error}
        </p>
      )}
    </Card>
  );
}
