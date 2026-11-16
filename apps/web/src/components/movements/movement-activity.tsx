"use client";

// The Activity reading of a movement: every run this automation has had,
// across all of its triggers, in one list.
//
// A run belongs to the AUTOMATION, not to the door the event came through —
// asking "did this work?" one trigger at a time is asking the wrong question,
// and it hides the case where two triggers fire the same script. So the
// history lives here, and a trigger page is a filtered link into it.
//
// The lane filter's options come from the runs themselves rather than from the
// listener list: the window is what it is, and offering a lane that cannot
// appear in it would be a filter that silently shows nothing.
//
// Below the runs sits the ARRIVAL ledger — every inbound event the automation's
// triggers caught, ran or not. The two answer different questions ("what did it
// do?" vs "did anything reach it?"), and the second is the only way to tell
// "nothing arrived" apart from "it arrived and nothing happened".

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, History, Inbox, Loader2 } from "lucide-react";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Badge, EmptyState } from "@/components/ui";
import { RecentActivityDetail } from "@/components/automations/recent-activity-detail";
import { laneShortForm } from "@/lib/trigger-name";
import { formatRunCostUsd } from "@/lib/run-cost";

import { replayForces } from "./arrival-replay";

type MovementRun = RouterOutputs["views"]["movement"]["runs"][number];
type MovementEvent = RouterOutputs["views"]["movement"]["events"][number];

/** The server hands back a fixed window; the UI says so rather than
 *  implying the list is everything. */
const RUN_WINDOW = 50;

export const LANE_PARAM = "lane";
export const STATUS_PARAM = "status";

/** How a run turned out, in the reader's terms. The stored status is an open
 *  string, so it is mapped onto this closed set once, here. */
const OUTCOMES = ["succeeded", "partial", "failed", "running", "waiting"] as const;
type Outcome = (typeof OUTCOMES)[number] | "other";

function isOutcomeFilter(value: string): value is (typeof OUTCOMES)[number] {
  return (OUTCOMES as readonly string[]).includes(value);
}

function outcomeOf(run: MovementRun): Outcome {
  if (run.failedAt !== null) return "failed";
  switch (run.status) {
    case "success":
      return "succeeded";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "parked":
      return "waiting";
    default:
      return "other";
  }
}

function outcomeLabel(outcome: Outcome): string {
  switch (outcome) {
    case "succeeded":
      return "Succeeded";
    case "partial":
      return "Partly done";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "other":
      return "Unknown";
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function outcomeTone(outcome: Outcome): "emerald" | "amber" | "red" | "sky" | "violet" | "gray" {
  switch (outcome) {
    case "succeeded":
      return "emerald";
    case "partial":
      return "amber";
    case "failed":
      return "red";
    case "running":
      return "sky";
    case "waiting":
      return "violet";
    case "other":
      return "gray";
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function formatRelative(date: Date | string): string {
  const d = new Date(date);
  const minutes = Math.round((Date.now() - d.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function formatDuration(run: MovementRun): string | null {
  const ended = run.completedAt ?? run.failedAt;
  if (!ended) return null;
  const ms = new Date(ended).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

const SELECT_CLASS =
  "rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[12px] text-gray-700 focus:border-gray-400 focus:outline-none";

export function MovementActivity({ movementId }: { movementId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { data, isLoading, error } = trpc.views.movement.runs.useQuery(
    { movementId },
    { refetchInterval: 15_000, refetchOnWindowFocus: true },
  );

  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const laneParam = searchParams.get(LANE_PARAM);
  const statusParam = searchParams.get(STATUS_PARAM);
  const statusFilter =
    statusParam !== null && isOutcomeFilter(statusParam) ? statusParam : null;

  // A filter choice lives in the URL so a filtered history is a link you can
  // send — which is what the trigger pages hand out.
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null) next.delete(key);
      else next.set(key, value);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const runs = useMemo(() => data ?? [], [data]);

  const lanes = useMemo(() => {
    const names = new Set(runs.map((r) => r.lane).filter((l) => l !== ""));
    // A lane named in the URL stays selectable even when the window holds no
    // run for it — otherwise the link a trigger page sends silently resets.
    if (laneParam) names.add(laneParam);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [runs, laneParam]);

  const visible = useMemo(
    () =>
      runs.filter((run) => {
        if (laneParam !== null && run.lane !== laneParam) return false;
        if (statusFilter !== null && outcomeOf(run) !== statusFilter) return false;
        return true;
      }),
    [runs, laneParam, statusFilter],
  );

  const filtered = laneParam !== null || statusFilter !== null;

  return (
    <div className="h-full overflow-y-auto px-6 py-5" data-testid="movement-activity">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
            Runs
          </h2>
          {/* One lane and no filter means there is nothing to choose between;
              a lane arriving in the URL always gets its control, so the filter
              a link applied can be cleared. */}
          {(lanes.length > 1 || laneParam !== null) && (
            <select
              aria-label="Filter by trigger"
              value={laneParam ?? ""}
              onChange={(e) => setParam(LANE_PARAM, e.target.value || null)}
              className={SELECT_CLASS}
              data-testid="activity-lane-filter"
            >
              <option value="">All triggers</option>
              {lanes.map((lane) => (
                <option key={lane} value={lane}>
                  {laneShortForm(lane)}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Filter by outcome"
            value={statusFilter ?? ""}
            onChange={(e) => setParam(STATUS_PARAM, e.target.value || null)}
            className={SELECT_CLASS}
            data-testid="activity-status-filter"
          >
            <option value="">All outcomes</option>
            {OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomeLabel(outcome)}
              </option>
            ))}
          </select>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-gray-400">
            <Loader2 size={15} className="animate-spin" />
            Loading this automation&rsquo;s runs…
          </div>
        ) : error ? (
          <div className="py-10 text-[13px] text-red-600">{error.message}</div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<History size={20} />}
            title={
              filtered
                ? "No runs match these filters."
                : "This automation hasn’t run yet."
            }
            caption={
              filtered
                ? "Widen the filters to see the rest of the history."
                : "The next time one of its triggers fires, the run shows up here."
            }
          />
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white">
            <ul className="divide-y divide-gray-100">
              {visible.map((run) => {
                const outcome = outcomeOf(run);
                const isOpen = expandedRunId === run.id;
                const duration = formatDuration(run);
                return (
                  <li key={run.id} data-testid={`activity-run-${run.id}`}>
                    <button
                      type="button"
                      onClick={() => setExpandedRunId(isOpen ? null : run.id)}
                      aria-expanded={isOpen}
                      className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-gray-50"
                    >
                      <span className="mt-0.5 shrink-0">
                        <Badge tone={outcomeTone(outcome)}>
                          {outcomeLabel(outcome)}
                        </Badge>
                      </span>
                      <span
                        className="mt-0.5 w-14 shrink-0 text-right text-[12px] tabular-nums text-gray-500"
                        title="Model-call cost"
                      >
                        {formatRunCostUsd(run.costMicrodollars)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {/* The summary already carries the failure reason
                              when there is one. */}
                          <span className="min-w-0 truncate text-[13px] text-gray-900">
                            {run.summary}
                          </span>
                          {run.dryRun && (
                            <Badge
                              tone="gray"
                              title="A rehearsal — it captured writes but didn't commit anything."
                            >
                              Rehearsal
                            </Badge>
                          )}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-400">
                          {run.lane !== "" && (
                            <>
                              <span className="font-mono text-gray-500">
                                {laneShortForm(run.lane)}
                              </span>
                              <span>·</span>
                            </>
                          )}
                          <span>{formatRelative(run.startedAt)}</span>
                          {duration && (
                            <>
                              <span>·</span>
                              <span>{duration}</span>
                            </>
                          )}
                          <span>·</span>
                          <span>
                            {run.nodesWritten}{" "}
                            {run.nodesWritten === 1 ? "record" : "records"} written
                          </span>
                        </span>
                      </span>
                      <ChevronDown
                        className={`mt-1 h-3.5 w-3.5 shrink-0 text-gray-300 transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    {isOpen && <RecentActivityDetail runId={run.id} />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="mt-3 text-[11px] text-gray-400">
          {filtered
            ? `${visible.length} of the last ${RUN_WINDOW} runs.`
            : `The last ${RUN_WINDOW} runs, across every trigger of this automation.`}
        </p>

        <EventsReceived movementId={movementId} lane={laneParam} />
      </div>
    </div>
  );
}

/** How an arrival reached a listen, in the reader's terms. */
const ARRIVAL_LABEL: Record<
  MovementEvent["status"],
  { label: string; tone: "emerald" | "red" | "amber" | "gray" }
> = {
  ran: { label: "Ran", tone: "emerald" },
  run_failed: { label: "Failed", tone: "red" },
  not_judged: { label: "Not judged", tone: "amber" },
};

/**
 * The arrival ledger, scoped to the same lane filter as the runs above: the
 * runs arrivals started, and the arrivals a listen could not judge (its
 * connected system could not give a field its filter reads). Replay puts
 * the kept delivery through that one listen again; a run it starts shows up
 * in the list above.
 */
function EventsReceived({
  movementId,
  lane,
}: {
  movementId: string;
  lane: string | null;
}) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.views.movement.events.useQuery(
    { movementId },
    { refetchInterval: 15_000, refetchOnWindowFocus: true },
  );

  // A kept request is shown to whoever may use the connection it came for
  // (each read recorded); the server refuses anyone else.
  const shown = trpc.views.triggers.showDeliveryRequest.useMutation();

  const replay = trpc.views.triggers.replayDelivery.useMutation({
    onSuccess: () => {
      void utils.views.movement.events.invalidate({ movementId });
      void utils.views.movement.runs.invalidate({ movementId });
    },
  });

  const runWith = trpc.views.movement.runWithEvent.useMutation({
    onSuccess: () => {
      void utils.views.movement.events.invalidate({ movementId });
      void utils.views.movement.runs.invalidate({ movementId });
    },
  });

  const events = useMemo(
    () => (data ?? []).filter((evt) => lane === null || evt.lane === lane),
    [data, lane],
  );

  if (isLoading) return null;

  return (
    <section className="mt-8" data-testid="movement-events-received">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
        Events received
      </h2>
      {events.length === 0 ? (
        <EmptyState
          icon={<Inbox size={20} />}
          title={
            lane !== null
              ? "Nothing has arrived on this trigger yet."
              : "Nothing has arrived yet."
          }
          caption="Every inbound event lands here, whether or not it ran anything."
        />
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white">
          <ul className="divide-y divide-gray-100">
            {events.map((evt) => {
              const arrival = ARRIVAL_LABEL[evt.status];
              const deliveryId = evt.deliveryId;
              return (
                <li
                  key={evt.id}
                  data-testid={`activity-event-${evt.id}`}
                  className="flex items-start gap-3 px-4 py-2.5"
                >
                  <span className="mt-0.5 shrink-0">
                    <Badge tone={arrival.tone}>{arrival.label}</Badge>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-gray-900">
                      {evt.adapterType}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-400">
                      {lane === null && evt.lane !== "" && (
                        <>
                          <span className="font-mono text-gray-500">
                            {laneShortForm(evt.lane)}
                          </span>
                          <span>·</span>
                        </>
                      )}
                      <span>{formatRelative(evt.occurredAt)}</span>
                    </span>
                    {evt.failureReason && (
                      <span className="mt-1 block text-[11px] text-red-600">
                        {evt.failureReason}
                      </span>
                    )}
                  </span>
                  {deliveryId !== null && (
                    <button
                      type="button"
                      disabled={shown.isLoading}
                      onClick={() => shown.mutate({ deliveryId })}
                      className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                      data-testid={`show-request-${evt.id}`}
                      title="Show the request this delivery came as. Your read is recorded."
                    >
                      Show request
                    </button>
                  )}
                  {deliveryId !== null && evt.arrivalIndex !== null && (
                    <button
                      type="button"
                      disabled={runWith.isLoading}
                      onClick={() =>
                        runWith.mutate({
                          id: movementId,
                          deliveryId,
                          arrivalIndex: evt.arrivalIndex ?? 0,
                        })
                      }
                      className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                      data-testid={`run-with-event-${evt.id}`}
                      title="Start this automation with this event's data, without its filters."
                    >
                      Run with this event
                    </button>
                  )}
                  {deliveryId !== null && (
                    <button
                      type="button"
                      disabled={replay.isLoading}
                      onClick={() =>
                        replay.mutate({
                          triggerId: evt.triggerId,
                          deliveryId,
                          // A run already started: run it again on purpose.
                          force: replayForces(evt.status),
                        })
                      }
                      className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                      data-testid={`replay-event-${evt.id}`}
                      title="Put this delivery through this listen again."
                    >
                      Replay
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {shown.data?.outcome === "refused" && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600"
              data-testid="show-request-refused"
            >
              {shown.data.reason}
            </div>
          )}
          {shown.data?.outcome === "shown" && (
            <pre
              className="max-h-80 overflow-auto border-t border-gray-100 px-4 py-2 text-[11px] text-gray-700"
              data-testid="show-request-kept"
            >
              {JSON.stringify(shown.data.kept, null, 2)}
            </pre>
          )}
          {shown.error && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600"
              data-testid="show-request-error"
            >
              {shown.error.message}
            </div>
          )}
          {replay.data?.outcome === "refused" && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600"
              data-testid="replay-refused"
            >
              {replay.data.reason}
            </div>
          )}
          {replay.data?.outcome === "replayed" && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-gray-600"
              data-testid="replay-outcome"
            >
              {replay.data.lines.join(" ")}
            </div>
          )}
          {runWith.data?.ok === false && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600"
              data-testid="run-with-event-refused"
            >
              {runWith.data.errors.join(" ")}
            </div>
          )}
          {runWith.data?.ok === true && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-gray-600"
              data-testid="run-with-event-started"
            >
              {runWith.data.runIds.length === 1 ? "One run queued." : `${runWith.data.runIds.length} runs queued.`}
            </div>
          )}
          {runWith.error && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600"
              data-testid="run-with-event-error"
            >
              {runWith.error.message}
            </div>
          )}
          {replay.error && (
            <div
              className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600"
              data-testid="replay-error"
            >
              {replay.error.message}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
