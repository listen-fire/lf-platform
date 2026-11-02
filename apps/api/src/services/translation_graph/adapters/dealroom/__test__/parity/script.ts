// The calls recorded parity makes, in order, against one Dealroom
// implementation. Each later call is built from what an earlier one answered,
// so the script walks the seeded graph the way a run would: search the root,
// read fields, walk every edge kind, re-read by id. The poll script polls the
// `Funding Rounds` edge as the platform's shared poll does (adapter protocol
// 2.6). The transcript is every answer, as JSON; two implementations agree
// when their transcripts and the requests they made are identical.

import type { Expression } from 'movement-lang/expression/types';
import type { Adapter, RelatedResult } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';
import type { EdgePoller } from '../../../../../poll_source/edge_poller';

import { makeMetaPosition } from 'movement-engine/public/catalog';

export interface ParitySubject {
  adapter: Adapter;
  poll: EdgePoller;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

const prop = (name: string): Expression => ({ type: 'property', propertyTypeId: name }) as Expression;
const value = (v: string | number | boolean | null): Expression => ({ type: 'static', value: v }) as Expression;
const cmp = (left: Expression, op: 'eq' | 'contains' | 'gte', right: Expression): Expression =>
  ({ type: 'compare', op, left, right }) as Expression;

/** A fixed cursor before the seed's two recent rounds, so the poll has
 *  something to deliver and never reads the clock. */
const POLL_CURSOR = { createdAfter: Date.UTC(2026, 0, 1) };
const EDGE = 'Funding Rounds';

function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function stepper(transcript: TranscriptEntry[]) {
  return async <T>(name: string, call: () => Promise<T>): Promise<T | undefined> => {
    try {
      const answer = await call();
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };
}

export async function runParityScript(subject: Pick<ParitySubject, 'adapter'>): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  const step = stepper(transcript);
  const related = (name: string, position: SourcePosition, fieldId: string, extra: Partial<{ where: Expression; orderBy: { fieldId: string; direction: 'asc' | 'desc' }; limit: number }> = {}) =>
    step(name, () => adapter.getRelated({ position, fieldId, direction: 'outgoing', ...extra }));
  const first = (results: RelatedResult[] | undefined): SourcePosition | undefined => results?.[0]?.position;

  const meta = makeMetaPosition('dealroom');
  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['Company', 'Investor', 'Person', 'Funding Round', 'Team Member', 'Round Investor', 'Fund', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  await step('edgesFrom meta', async () => adapter.edgesFrom?.(meta) ?? null);

  // The root searches: WHERE pushdown, sort pushdown, a sort that cannot travel.
  const byDomain = await related('Companies WHERE Website', meta, 'Companies', { where: cmp(prop('Website'), 'eq', value('vaultwise.de')) });
  await related('Companies WHERE Industries ORDER BY Total Funding LIMIT 3', meta, 'Companies', {
    where: cmp(prop('Industries'), 'eq', value('Fintech')),
    orderBy: { fieldId: 'Total Funding', direction: 'desc' },
    limit: 3,
  });
  await related('Companies WHERE Name CONTAINS', meta, 'Companies', { where: cmp(prop('Name'), 'contains', value('ly')) });
  const investors = await related('Investors', meta, 'Investors', { orderBy: { fieldId: 'Name', direction: 'asc' }, limit: 2 });
  await related('People WHERE Is Strong Founder', meta, 'People', { where: cmp(prop('Is Strong Founder'), 'eq', value(true)), limit: 3 });
  await related('Funding Rounds WHERE Date', meta, 'Funding Rounds', { where: cmp(prop('Date'), 'gte', value('2025-01-01')) });

  const company = first(byDomain);
  if (company !== undefined) {
    for (const field of ['Name', 'Website', 'Website URL', 'Logo URL', 'HQ City', 'HQ Country', 'Industries', 'Tags', 'Last Updated', 'Created At', 'Total Funding']) {
      await step(`Company.${field}`, () => adapter.getFieldValue({ position: company, fieldId: field }));
    }
    const rounds = await related('Company Funding Rounds', company, 'Funding Rounds');
    await related('Company Investors', company, 'Investors');
    const team = await related('Company Team WHERE Is Founder', company, 'Team', { where: cmp(prop('Is Founder'), 'eq', value(true)) });
    await related('Company Similar Companies', company, 'Similar Companies', { limit: 2 });

    const member = first(team);
    if (member !== undefined) {
      const person = first(await related('Team Member Person', member, 'Person'));
      if (person !== undefined) await related('Person Companies', person, 'Companies');
    }
    const round = first(rounds);
    if (round !== undefined) {
      await step('Funding Round.Date', () => adapter.getFieldValue({ position: round, fieldId: 'Date' }));
      await related('Funding Round Company', round, 'Company');
      const participation = first(await related('Funding Round Investors', round, 'Investors'));
      if (participation !== undefined) await related('Round Investor Investor', participation, 'Investor');
    }
  }

  const investor = first(investors);
  if (investor !== undefined) {
    for (const edge of ['Investments', 'Funding Rounds', 'Co-Investors', 'Funds', 'Team']) {
      await related(`Investor ${edge}`, investor, edge);
    }
  }

  await step('readRecord Company 3', async () => (await adapter.readRecord?.({ recordType: 'Company', externalId: '3' })) ?? null);
  await step('readRecord Investor 1', async () => (await adapter.readRecord?.({ recordType: 'Investor', externalId: '1' })) ?? null);
  await step('readRecord Person 1', async () => (await adapter.readRecord?.({ recordType: 'Person', externalId: '1' })) ?? null);
  await step('readRecord Company 999', async () => (await adapter.readRecord?.({ recordType: 'Company', externalId: '999' })) ?? null);
  await step('readRecord Funding Round', async () => (await adapter.readRecord?.({ recordType: 'Funding Round', externalId: '1' })) ?? null);
  return transcript;
}

export async function runPollScript(subject: ParitySubject): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  const step = stepper(transcript);
  await step('poll from a cursor', () => subject.poll({ edge: EDGE, cursor: POLL_CURSOR }));
  // Dealroom judges a round's terms itself (its `rounds` terms filter).
  await step('poll taking Round CONTAINS', () =>
    subject.poll({ edge: EDGE, filter: cmp(prop('Round'), 'contains', value('Series A')), cursor: POLL_CURSOR }),
  );
  await step('poll past the newest', () => subject.poll({ edge: EDGE, cursor: { createdAfter: Date.UTC(2030, 0, 1) } }));
  await step('poll an edge that is not polled', () => subject.poll({ edge: 'Companies', cursor: POLL_CURSOR }));
  return transcript;
}
