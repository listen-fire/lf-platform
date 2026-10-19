'use client';

import { useState, useCallback } from 'react';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import {
  SectionHeader,
  Button,
  Badge,
} from '@/components/ui';
import { InfiniteList } from '@/components/infinite-list';

type EventRow = {
  id: string;
  teamId: string;
  teamName: string | null;
  trigger_id: string;
  adapter_type: string;
  trigger_type: string;
  status: string;
  failure_reason: string | null;
  occurred_at: string | Date;
  created_at: string | Date;
};

type ReplayResult = RouterOutputs['views']['admin']['crossTeamOps']['replayTriggerEvent'];

function fmt(d: string | Date | null): string {
  if (d === null) return '—';
  return new Date(d).toLocaleString();
}

const STATUS_TONE: Record<string, 'emerald' | 'gray' | 'red' | 'amber'> = {
  dispatched: 'emerald',
  success: 'emerald',
  ok: 'emerald',
  error: 'red',
  failed: 'red',
  dropped: 'amber',
};

function statusTone(status: string): 'emerald' | 'gray' | 'red' | 'amber' {
  return STATUS_TONE[status.toLowerCase()] ?? 'gray';
}

// ─── Replay modal (the safety-critical surface) ───────────────────────────────

function ReplayModal({ event, onClose }: { event: EventRow; onClose: () => void }) {
  const [live, setLive] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);

  const replay = trpc.views.admin.crossTeamOps.replayTriggerEvent.useMutation({
    onSuccess: (r) => setResult(r),
  });
  // The replay answers with its run's id before the run starts; follow it.
  const run = trpc.views.admin.crossTeamOps.replayRunStatus.useQuery(
    { runId: result?.runId ?? '' },
    {
      enabled: result !== null,
      refetchInterval: (data) =>
        data !== undefined && !('error' in data) && data.status === 'running' ? 1500 : false,
    },
  );
  const runStatus = run.data;
  const settling =
    result !== null &&
    (runStatus === undefined || (!('error' in runStatus) && runStatus.status === 'running'));

  const dryRun = !live;

  const fire = () => {
    setResult(null);
    replay.mutate({ eventId: event.id, dryRun });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-100 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-gray-900">Replay event</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="text-[12px] text-gray-500">
            <div>
              <span className="text-gray-400">Team:</span> {event.teamName ?? event.teamId}
            </div>
            <div>
              <span className="text-gray-400">Trigger:</span> {event.adapter_type} /{' '}
              {event.trigger_type}
            </div>
            <div>
              <span className="text-gray-400">Occurred:</span> {fmt(event.occurred_at)}
            </div>
          </div>

          {/* Mode selector — dry-run is the pre-selected, primary option. */}
          <div className="flex flex-col gap-2 rounded-lg border border-gray-100 p-3">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="replay-mode"
                checked={dryRun}
                onChange={() => {
                  setLive(false);
                  setResult(null);
                }}
                className="mt-0.5"
              />
              <span>
                <span className="text-[13px] font-medium text-gray-900">
                  Dry run (rehearse)
                </span>
                <span className="block text-[11px] leading-relaxed text-gray-400">
                  Re-runs the automation and shows what it would write. Nothing is
                  committed.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="replay-mode"
                checked={live}
                onChange={() => {
                  setLive(true);
                  setResult(null);
                }}
                className="mt-0.5 accent-red-600"
              />
              <span>
                <span className="text-[13px] font-medium text-red-700">
                  Replay live — commits real writes
                </span>
                <span className="block text-[11px] leading-relaxed text-gray-400">
                  Re-runs against live systems and writes real records.
                </span>
              </span>
            </label>
          </div>

          {live && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-[12px] leading-relaxed text-red-700">
                This re-runs the automation against live systems and writes real records.
                Live still respects the trigger&apos;s run_mode (off / dry_run / live).
              </p>
            </div>
          )}

          {/* Result summary */}
          {result && (
            <div
              className={`rounded-lg border p-3 text-[12px] leading-relaxed ${
                runStatus !== undefined && ('error' in runStatus || runStatus.status === 'failed')
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : 'border-gray-100 bg-gray-50 text-gray-700'
              }`}
            >
              {runStatus === undefined || settling ? (
                <div>{result.dryRun ? 'Rehearsing…' : 'Replaying…'}</div>
              ) : 'error' in runStatus ? (
                <div className="font-medium">Error: {runStatus.error}</div>
              ) : runStatus.status === 'failed' ? (
                <div className="font-medium">
                  Error: {runStatus.failureReason ?? 'the run failed'}
                </div>
              ) : runStatus.status === 'parked' ? (
                <div>The run is waiting (an ask, a timer or its cost limit).</div>
              ) : result.dryRun ? (
                <div>
                  Would write ~{runStatus.recordCount} record
                  {runStatus.recordCount === 1 ? '' : 's'}. Nothing committed.
                </div>
              ) : (
                <div>
                  Ran: {runStatus.recordCount} write
                  {runStatus.recordCount === 1 ? '' : 's'}
                  {runStatus.dryRun ? ' (rehearsed by its run_mode)' : ''}.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3.5">
          <Button variant="ghost" size="md" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          {dryRun ? (
            <Button
              variant="primary"
              size="md"
              disabled={replay.isLoading || settling}
              onClick={fire}
            >
              {replay.isLoading || settling ? 'Running…' : 'Run dry run'}
            </Button>
          ) : (
            <Button
              variant="danger"
              size="md"
              disabled={replay.isLoading || settling}
              onClick={fire}
            >
              {replay.isLoading || settling ? 'Replaying…' : 'Replay live'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Team filter ──────────────────────────────────────────────────────────────

function TeamFilter({
  teams,
  selectedTeamId,
  onChange,
}: {
  teams: Array<{ id: string; name: string }>;
  selectedTeamId: string | undefined;
  onChange: (teamId: string | undefined) => void;
}) {
  return (
    <select
      value={selectedTeamId ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? undefined : v);
      }}
      className="rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] text-gray-700 focus:border-gray-400 focus:outline-none"
    >
      <option value="">All teams</option>
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

// ─── Tab ──────────────────────────────────────────────────────────────────────

export function EventsTab() {
  const utils = trpc.useUtils();
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>(undefined);
  const [replayEvent, setReplayEvent] = useState<EventRow | null>(null);

  const teams = trpc.views.admin.userManagement.getTeams.useQuery();
  const getLogsUrl = trpc.views.admin.logs.getLogsUrl.useMutation({
    // Null when this deployment is not on Render — nothing to open.
    onSuccess: (url) => {
      if (url) window.open(url, '_blank', 'noopener');
    },
  });

  const fetchPage = useCallback(
    (search: string, limit: number, offset: number) =>
      utils.views.admin.crossTeamOps.listTriggerEvents.fetch({
        search: search || undefined,
        teamId: selectedTeamId,
        limit,
        offset,
      }),
    [utils, selectedTeamId],
  );

  return (
    <section>
      <SectionHeader
        title="Events"
        subtitle="Trigger events — replay re-runs the automation"
      />
      <InfiniteList<EventRow>
        fetchPage={fetchPage}
        rowHeight={72}
        searchPlaceholder="Search events…"
        emptyLabel="No trigger events."
        toolbar={
          <TeamFilter
            teams={teams.data ?? []}
            selectedTeamId={selectedTeamId}
            onChange={setSelectedTeamId}
          />
        }
        renderRow={(ev) => (
          <div className="flex h-full items-center gap-3 border-b border-gray-100 px-4">
            <div className="w-36 shrink-0 truncate text-[12px] text-gray-500">
              {ev.teamName ?? ev.teamId}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-gray-900">
                  {ev.adapter_type} / {ev.trigger_type}
                </span>
                <Badge tone={statusTone(ev.status)}>{ev.status}</Badge>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-400">
                <span>{fmt(ev.occurred_at)}</span>
                {ev.failure_reason && (
                  <span className="text-red-500">{ev.failure_reason}</span>
                )}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={getLogsUrl.isLoading}
              onClick={() => getLogsUrl.mutate({ requestId: ev.id })}
            >
              Logs ↗
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setReplayEvent(ev)}>
              Replay
            </Button>
          </div>
        )}
      />

      {replayEvent && (
        <ReplayModal event={replayEvent} onClose={() => setReplayEvent(null)} />
      )}
    </section>
  );
}
