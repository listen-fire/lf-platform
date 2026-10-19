// A deterministic stand-in for the Valuations REST API (/api/v1/valuations/*),
// for recorded parity: there is no Valuations in fake-channels. Rows live in
// memory, seeded fresh per boot; each child row carries its parents' ids in
// the foreign key columns the adapter's down edges filter on. A list filters
// by equality on any column it is given (and `search`, a case-insensitive
// contains on the name), pages by limit and offset, and answers in insert
// order. A create mints the next id of its kind; `/compute` and the commands
// answer canned rows and receipts. Every request needs the seeded key.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_VALUATIONS_API_KEY = 'parity-valuations-key';

const CREATED_AT = '2026-09-01T09:00:00.000Z';

type Row = Record<string, unknown>;

/** Rows by REST slug, in insert order. */
function seededRows(): Map<string, Row[]> {
  const stamp = (row: Row): Row => ({ ...row, created_at: CREATED_AT, updated_at: CREATED_AT });
  return new Map<string, Row[]>([
    [
      'legal-entities',
      [
        { id: 'le-fund', type: 'FUND', name: 'Northwind Capital', legal_name: 'Northwind Capital I LP', also_known_as: null, personal_website: null, other_names: [], investing_entity_id: null, underlying_company_id: null, acquired_by_legal_entity_id: null, is_own_investing_entity: true },
        { id: 'le-acme', type: 'PORTFOLIO_COMPANY', name: 'Acme Robotics', legal_name: 'Acme Robotics GmbH', also_known_as: 'Acme', personal_website: 'https://www.acme.example/', other_names: ['ACME Bots'], investing_entity_id: 'le-fund', underlying_company_id: null, acquired_by_legal_entity_id: null, is_portfolio: true },
        { id: 'le-beta', type: 'PORTFOLIO_COMPANY', name: 'Beta Labs', legal_name: null, also_known_as: 'Acme Beta', personal_website: 'beta.example', other_names: [], investing_entity_id: 'le-fund', underlying_company_id: null, acquired_by_legal_entity_id: null, is_portfolio: true },
      ].map(stamp),
    ],
    [
      'investments',
      [
        { id: 'inv-1', round_type: 'SEED', type: 'CASH', invested_at: '2024-03-01', investor_profile_id: 'le-fund', investment_profile_id: 'le-acme', event_id: 'event-1', exit_event_id: null },
        { id: 'inv-2', round_type: 'SERIES_A', type: 'CASH', invested_at: '2025-06-01', investor_profile_id: 'le-fund', investment_profile_id: 'le-beta', event_id: 'event-2', exit_event_id: null },
      ].map(stamp),
    ],
    [
      'events',
      [
        { id: 'event-1', type: 'INVESTMENT_ROUND', date: '2024-03-01', legal_entity_id: 'le-acme' },
        { id: 'event-2', type: 'INVESTMENT_ROUND', date: '2025-06-01', legal_entity_id: 'le-beta' },
      ].map(stamp),
    ],
    [
      'transactions',
      [
        { id: 'tx-1', close_date: '2024-03-02', amount: 500000, currency: 'EUR', investment_id: 'inv-1', event_id: 'event-1', converted_to_id: null, due_to_rights_from_asset_id: null },
        { id: 'tx-2', close_date: '2025-06-02', amount: 1200000, currency: 'EUR', investment_id: 'inv-2', event_id: 'event-2', converted_to_id: null, due_to_rights_from_asset_id: null },
      ].map(stamp),
    ],
    [
      'assets',
      [
        { id: 'asset-1', type: 'EQUITY', name: 'Acme Ordinary', issued_by_legal_entity_id: 'le-acme', convertible_investor_id: null },
        { id: 'asset-cash', type: 'CURRENCY', name: 'EUR cash', issued_by_legal_entity_id: null, convertible_investor_id: null },
      ].map(stamp),
    ],
    [
      'asset-transfers',
      [
        { id: 'at-1', date: '2024-03-02', num_assets: 1000, asset_id: 'asset-1', transaction_id: 'tx-1', from_legal_entity_id: 'le-acme', to_legal_entity_id: 'le-fund' },
      ].map(stamp),
    ],
    [
      'prices',
      [
        { id: 'price-1', date: '2024-03-01', price: 1.5, currency: 'EUR', type: 'FROM_PRICED_ROUND', asset_id: 'asset-1' },
        { id: 'price-2', date: '2025-01-01', price: 2.25, currency: 'EUR', type: 'FROM_ASSET_HOLDER', asset_id: 'asset-1' },
      ].map(stamp),
    ],
  ]);
}

/** What each command answers: the ids of the records it would have written. */
const COMMAND_RECEIPTS: Record<string, Row> = {
  'add-markdown': { eventId: 'event-1', priceIds: ['price-1', 'price-2'] },
  'add-investment': { investmentId: 'inv-1', eventId: 'event-1', transactionId: 'tx-1' },
  'add-price': { priceId: 'price-2' },
  'add-round': { eventId: 'event-2', priceId: 'price-2' },
  'add-wind-down': { eventId: 'event-2' },
  'add-share-split': { eventId: 'event-2' },
  'add-dividends': { eventId: 'event-2' },
  'add-fund-distribution': { eventId: 'event-2' },
  'add-fund-drawdown': { transactionId: 'tx-2', priceId: 'price-2' },
};

/** `/compute` rows, one per underlying investment. */
const COMPUTE_ROWS = [
  { investment_id: 'inv-1', invested: { valuation_date_value: 500000 }, unrealized: { valuation_date_value: 750000 }, realized: { valuation_date_value: 0 }, total: { valuation_date_value: 750000 } },
  { investment_id: 'inv-2', invested: { valuation_date_value: 1200000 }, unrealized: { valuation_date_value: 900000 }, realized: { valuation_date_value: 100000 }, total: { valuation_date_value: 1000000 } },
];

const PREFIX = '/api/v1/valuations';

export interface FakeValuations {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function bootFakeValuations(): Promise<FakeValuations> {
  const rows = seededRows();
  const minted = new Map<string, number>();
  const webhooks: Row[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${FAKE_VALUATIONS_API_KEY}`) return send(401, { error: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://fake');
      if (!url.pathname.startsWith(`${PREFIX}/`)) return send(404, { error: 'not found' });
      const segments = url.pathname.slice(PREFIX.length + 1).split('/');
      const text = Buffer.concat(chunks).toString('utf8');
      const body: Row = text === '' ? {} : (JSON.parse(text) as Row);
      const method = req.method ?? 'GET';

      if (segments[0] === 'compute' && method === 'POST') return send(200, { data: COMPUTE_ROWS });
      if (segments[0] === 'commands' && method === 'POST') {
        const receipt = COMMAND_RECEIPTS[segments[1] ?? ''];
        return receipt === undefined ? send(404, { error: 'unknown command' }) : send(201, { data: receipt });
      }
      if (segments[0] === 'webhooks') {
        if (method === 'POST') {
          const created = { id: `webhook-${webhooks.length + 1}`, url: body.url, eventTypes: body.eventTypes };
          webhooks.push(created);
          return send(201, { data: created });
        }
        if (method === 'DELETE') return send(204);
      }

      const collection = rows.get(segments[0] ?? '');
      if (collection === undefined) return send(404, { error: `no resource ${segments[0]}` });
      const id = segments[1];
      if (id === undefined) {
        if (method === 'GET') {
          const limit = Number(url.searchParams.get('limit') ?? 50);
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const search = url.searchParams.get('search')?.toLowerCase();
          const filters = [...url.searchParams.entries()].filter(([key]) => !['limit', 'offset', 'search'].includes(key));
          const matching = collection.filter(
            (row) =>
              (search === undefined || String(row.name ?? '').toLowerCase().includes(search)) &&
              filters.every(([key, wanted]) => String(row[key] ?? '') === wanted),
          );
          return send(200, { data: matching.slice(offset, offset + limit), pagination: { limit, offset, total: matching.length } });
        }
        if (method === 'POST') {
          const kind = segments[0] ?? '';
          const n = (minted.get(kind) ?? 0) + 1;
          minted.set(kind, n);
          const created = { id: `${kind}-new-${n}`, ...body, created_at: CREATED_AT, updated_at: CREATED_AT };
          collection.push(created);
          return send(201, { data: created });
        }
        return send(405, { error: 'method not allowed' });
      }
      const at = collection.findIndex((row) => row.id === id);
      if (at < 0) return send(404, { error: `${segments[0]} ${id} not found` });
      if (method === 'GET') return send(200, { data: collection[at] });
      if (method === 'PATCH') {
        collection[at] = { ...collection[at], ...body, updated_at: CREATED_AT };
        return send(200, { data: collection[at] });
      }
      if (method === 'DELETE') {
        collection.splice(at, 1);
        return send(204);
      }
      return send(405, { error: 'method not allowed' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
