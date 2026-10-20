'use client';

import { useState, useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import {
  PageHeader,
  PageBody,
  PageIntro,
  SectionHeader,
  CardList,
  ListRow,
  Badge,
} from '@/components/ui';
import { InfiniteList } from '@/components/infinite-list';

// ─── UsageMeter ──────────────────────────────────────────────────────────────
// Mirrors the visual from apps/web/src/app/(app)/settings/page.tsx UsageMeter.

interface UsageStatus {
  allowed: boolean;
  used: number;
  weeklyMax: number;
  additional: number;
  effectiveLimit: number;
  remaining: number;
  periodStart: string | Date;
  periodEnd: string | Date;
}

function UsageMeter({
  label,
  status,
  thresholdPct,
}: {
  label: string;
  status: UsageStatus;
  thresholdPct: number;
}) {
  const { used, weeklyMax, additional, effectiveLimit } = status;
  const pct = effectiveLimit > 0 ? Math.min(100, (used / effectiveLimit) * 100) : 0;
  const thresholdReached = pct >= thresholdPct;
  const exhausted = used >= effectiveLimit;

  const barColor = exhausted
    ? 'bg-red-500'
    : thresholdReached
      ? 'bg-amber-500'
      : 'bg-gray-400';

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-gray-700">{label}</span>
        <span className="text-[12px] text-gray-400">
          {used} / {effectiveLimit}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full rounded-full bg-gray-100">
        <div
          className={`h-2 rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {additional > 0 && (
        <div className="mt-1 text-[11px] text-gray-400">
          {Math.max(0, additional - Math.max(0, used - weeklyMax))} additional available
        </div>
      )}
    </div>
  );
}

// ─── BillingContacts ──────────────────────────────────────────────────────────
// getBillingContacts returns { email, userId } — no userEmailId or isBillingContact
// flag. The toggle requires userEmailId to call setBillingContact, which we don't
// have here. Contacts are shown read-only; this is correct rather than broken.

function BillingContacts({ teamId, teamName, onClear }: { teamId: string; teamName: string; onClear: () => void }) {
  const { data: contacts, isLoading } =
    trpc.views.admin.crossTeamOps.getBillingContacts.useQuery({ teamId });

  return (
    <div className="mt-8 rounded-xl border border-gray-100 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <SectionHeader
          title={`Billing Contacts — ${teamName}`}
          subtitle="Contacts who receive usage alerts for this team"
        />
        <button
          onClick={onClear}
          className="shrink-0 text-[12px] text-gray-400 hover:text-gray-700"
        >
          Clear
        </button>
      </div>

      {isLoading ? (
        <div className="h-12 animate-pulse rounded-xl bg-gray-100" />
      ) : !contacts || contacts.length === 0 ? (
        <p className="text-[12px] text-gray-400">No billing contacts configured for this team.</p>
      ) : (
        <CardList>
          {contacts.map((c) => (
            <ListRow key={c.userId}>
              <span className="text-[13px] text-gray-700">{c.email}</span>
            </ListRow>
          ))}
        </CardList>
      )}
    </div>
  );
}

// ─── Usage row shape ──────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type TeamUsageRow = {
  teamId: string;
  teamName: string;
  queryInputs: UsageStatus | null;
  alertThresholdPct: number;
  weekStartsOn: number;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UsagePage() {
  const utils = trpc.useUtils();
  const [selectedTeam, setSelectedTeam] = useState<{ id: string; name: string } | null>(null);

  const fetchPage = useCallback(
    (search: string, limit: number, offset: number) =>
      utils.views.admin.crossTeamOps.listUsageAcrossTeams.fetch({
        search: search || undefined,
        limit,
        offset,
      }),
    [utils],
  );

  return (
    <>
      <PageHeader title="Usage" />
      <PageBody>
        <PageIntro>
          Weekly usage across all teams. Click a row to see billing contacts for that team.
        </PageIntro>

        <SectionHeader title="Usage" subtitle="All teams" />

        <InfiniteList<TeamUsageRow>
          fetchPage={fetchPage}
          rowHeight={96}
          searchPlaceholder="Search teams…"
          emptyLabel="No teams found."
          renderRow={(row) => {
            const resetDay = DAY_NAMES[row.weekStartsOn] ?? 'Monday';
            const hasConfig = row.queryInputs !== null;
            const isSelected = selectedTeam?.id === row.teamId;

            return (
              <button
                type="button"
                className={`flex h-full w-full items-center border-b border-gray-100 px-4 text-left transition-colors hover:bg-gray-50 ${
                  isSelected ? 'bg-gray-50' : ''
                }`}
                onClick={() =>
                  setSelectedTeam(
                    isSelected ? null : { id: row.teamId, name: row.teamName },
                  )
                }
              >
                <div className="flex min-w-0 flex-1 flex-col gap-3 py-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-gray-900">{row.teamName}</span>
                    {hasConfig && (
                      <span className="text-[11px] text-gray-400">Resets {resetDay}</span>
                    )}
                    {!hasConfig && <Badge tone="gray">no config</Badge>}
                  </div>

                  {hasConfig ? (
                    <div className="flex gap-6">
                      {row.queryInputs ? (
                        <UsageMeter
                          label="Questions"
                          status={row.queryInputs}
                          thresholdPct={row.alertThresholdPct}
                        />
                      ) : (
                        <div className="flex-1 min-w-0">
                          <span className="text-[12px] text-gray-400">Questions — no config</span>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          }}
        />

        {selectedTeam && (
          <BillingContacts
            teamId={selectedTeam.id}
            teamName={selectedTeam.name}
            onClear={() => setSelectedTeam(null)}
          />
        )}
      </PageBody>
    </>
  );
}
