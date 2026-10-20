'use client';

import { useState, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { PageHeader, PageBody, EmptyState, Badge } from '@/components/ui';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatCost(microdollars: number): string {
  const dollars = microdollars / 1_000_000;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function getDefaultDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// ─── Table primitives ─────────────────────────────────────────────────────────

function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-[13px]">{children}</table>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 ${right ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  );
}

function Td({ children, right, mono, bold }: { children: React.ReactNode; right?: boolean; mono?: boolean; bold?: boolean }) {
  return (
    <td
      className={`border-b border-gray-100 px-4 py-2.5 text-gray-700 last:border-b-0 ${right ? 'text-right tabular-nums' : ''} ${mono ? 'font-mono text-[12px]' : ''} ${bold ? 'font-semibold text-gray-900' : ''}`}
    >
      {children}
    </td>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 py-2">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-gray-100" />
      ))}
    </div>
  );
}

// ─── Tab strip ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'team', label: 'By Team' },
  { id: 'model', label: 'By Model' },
  { id: 'label', label: 'By Label' },
  { id: 'conversation', label: 'By Conversation' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function TabStrip({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  return (
    <div className="mb-6 flex items-center gap-1 border-b border-gray-100">
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`-mb-px cursor-pointer border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              isActive
                ? 'border-primary text-gray-900'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Tab tables ───────────────────────────────────────────────────────────────

type DateParams = { teamId?: string; startDate: string; endDate: string };

function TeamTable({ params }: { params: DateParams }) {
  const { data, isLoading } = trpc.views.admin.llmUsage.summary.useQuery(params);

  if (isLoading) return <Skeleton />;
  if (!data?.length)
    return <EmptyState title="No data for this period." />;

  return (
    <Table>
      <thead>
        <tr>
          <Th>Team</Th>
          <Th right>Calls</Th>
          <Th right>Input tokens</Th>
          <Th right>Output tokens</Th>
          <Th right>Cache read</Th>
          <Th right>Cost</Th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr key={row.team_id} className="hover:bg-gray-50">
            <Td>{row.team_name}</Td>
            <Td right>{row.call_count.toLocaleString()}</Td>
            <Td right>{formatTokens(row.total_input_tokens)}</Td>
            <Td right>{formatTokens(row.total_output_tokens)}</Td>
            <Td right>{formatTokens(row.total_cache_read_tokens)}</Td>
            <Td right bold>{formatCost(row.total_cost_microdollars)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ModelTable({ params }: { params: DateParams }) {
  const { data, isLoading } = trpc.views.admin.llmUsage.byModel.useQuery(params);

  if (isLoading) return <Skeleton />;
  if (!data?.length)
    return <EmptyState title="No data for this period." />;

  return (
    <Table>
      <thead>
        <tr>
          <Th>Provider</Th>
          <Th>Model</Th>
          <Th right>Calls</Th>
          <Th right>Input tokens</Th>
          <Th right>Output tokens</Th>
          <Th right>Cost</Th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr key={`${row.provider}-${row.model}`} className="hover:bg-gray-50">
            <Td>
              <Badge tone={row.provider === 'anthropic' ? 'amber' : 'emerald'}>
                {row.provider}
              </Badge>
            </Td>
            <Td mono>{row.model}</Td>
            <Td right>{row.call_count.toLocaleString()}</Td>
            <Td right>{formatTokens(row.total_input_tokens)}</Td>
            <Td right>{formatTokens(row.total_output_tokens)}</Td>
            <Td right bold>{formatCost(row.total_cost_microdollars)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function LabelTable({ params }: { params: DateParams }) {
  const { data, isLoading } = trpc.views.admin.llmUsage.byLabel.useQuery(params);

  if (isLoading) return <Skeleton />;
  if (!data?.length)
    return <EmptyState title="No data for this period." />;

  return (
    <Table>
      <thead>
        <tr>
          <Th>Label</Th>
          <Th>Call type</Th>
          <Th right>Calls</Th>
          <Th right>Input tokens</Th>
          <Th right>Output tokens</Th>
          <Th right>Cost</Th>
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i} className="hover:bg-gray-50">
            <Td mono>{row.label}</Td>
            <Td>
              <Badge tone="gray">{row.call_type}</Badge>
            </Td>
            <Td right>{row.call_count.toLocaleString()}</Td>
            <Td right>{formatTokens(row.total_input_tokens)}</Td>
            <Td right>{formatTokens(row.total_output_tokens)}</Td>
            <Td right bold>{formatCost(row.total_cost_microdollars)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ConversationTable({ params }: { params: DateParams }) {
  const { data, isLoading } = trpc.views.admin.llmUsage.byConversation.useQuery({
    ...params,
    limit: 50,
  });

  if (isLoading) return <Skeleton />;
  if (!data?.length)
    return <EmptyState title="No conversation data for this period." />;

  return (
    <Table>
      <thead>
        <tr>
          <Th>Conversation</Th>
          <Th>Team</Th>
          <Th>Created</Th>
          <Th right>Calls</Th>
          <Th right>Input tokens</Th>
          <Th right>Output tokens</Th>
          <Th right>Cost</Th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr key={row.conversation_id} className="hover:bg-gray-50">
            <Td>
              <span className="block max-w-[200px] truncate">
                {row.conversation_title || <span className="font-mono text-[12px]">{row.conversation_id?.slice(0, 8)}</span>}
              </span>
            </Td>
            <Td>{row.team_name}</Td>
            <Td>
              {row.conversation_created_at
                ? new Date(row.conversation_created_at).toLocaleDateString()
                : '—'}
            </Td>
            <Td right>{row.call_count.toLocaleString()}</Td>
            <Td right>{formatTokens(row.total_input_tokens)}</Td>
            <Td right>{formatTokens(row.total_output_tokens)}</Td>
            <Td right bold>{formatCost(row.total_cost_microdollars)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LlmUsagePage() {
  const defaults = useMemo(() => getDefaultDateRange(), []);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [teamId, setTeamId] = useState('');
  const [activeTab, setActiveTab] = useState<TabId>('team');

  const { data: teams } = trpc.views.admin.llmUsage.teams.useQuery();

  const dateParams = useMemo(
    () => ({
      teamId: teamId || undefined,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate + 'T23:59:59').toISOString(),
    }),
    [teamId, startDate, endDate],
  );

  const { data: summary, isLoading: summaryLoading } =
    trpc.views.admin.llmUsage.summary.useQuery(dateParams);

  const totalCost = summary?.reduce((sum, row) => sum + row.total_cost_microdollars, 0) ?? 0;
  const totalCalls = summary?.reduce((sum, row) => sum + row.call_count, 0) ?? 0;
  const teamCount = summary?.length ?? 0;

  return (
    <>
      <PageHeader title="LLM Usage" />
      <PageBody width="wide">
        {/* Controls */}
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-gray-500">From</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-gray-500">To</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="">All teams</option>
            {teams?.map((t) => (
              <option key={t.team_id} value={t.team_id}>
                {t.team_name}
              </option>
            ))}
          </select>
        </div>

        {/* Summary stats */}
        <div className="mb-8 flex gap-6">
          {[
            {
              label: 'Total cost',
              value: summaryLoading ? '—' : formatCost(totalCost),
            },
            {
              label: 'LLM calls',
              value: summaryLoading ? '—' : totalCalls.toLocaleString(),
            },
            {
              label: 'Teams',
              value: summaryLoading ? '—' : String(teamCount),
            },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-gray-400">{label}</span>
              <span className="text-xl font-semibold text-gray-900">{value}</span>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <TabStrip active={activeTab} onChange={setActiveTab} />
        {activeTab === 'team' && <TeamTable params={dateParams} />}
        {activeTab === 'model' && <ModelTable params={dateParams} />}
        {activeTab === 'label' && <LabelTable params={dateParams} />}
        {activeTab === 'conversation' && <ConversationTable params={dateParams} />}
      </PageBody>
    </>
  );
}
