import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { EntityStore } from '../../store';
import { seedDefaults } from '../../seed';
import { dealroomRoutes } from '../dealroom';
import { adminRoutes } from '../admin';

/**
 * Route-level tests for the fake Dealroom service, run via `node --test`
 * (through `tsx --test`, no jest in this package — see package.json). Each
 * test boots its own EntityStore against a throwaway sqlite file so tests
 * don't share state or clobber the dev-loop's `test-harness-data/fake-channels.db`.
 */

function basicAuth(key = 'dev-loop-dealroom-key'): { Authorization: string } {
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dealroom-test-')), 'fake-channels.db');
  const store = new EntityStore(dbPath);
  seedDefaults(store);

  const app = express();
  app.use(express.json());
  app.use('/dealroom', dealroomRoutes(store));
  app.use('/admin', adminRoutes(store));

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('dealroom: 401 without an Authorization header', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.message, 'Unauthorized');
  } finally {
    await close();
  }
});

test('dealroom: name search, exact and fuzzy', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const exact = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ keyword: 'Nimbusly', keyword_type: 'name', keyword_match_type: 'exact' }),
    }).then((r) => r.json());
    assert.equal(exact.total, 1);
    assert.equal(exact.items[0].name, 'Nimbusly');

    const fuzzy = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ keyword: 'nimbus', keyword_type: 'name', keyword_match_type: 'fuzzy' }),
    }).then((r) => r.json());
    assert.equal(fuzzy.total, 1);
    assert.equal(fuzzy.items[0].name, 'Nimbusly');

    const miss = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ keyword: 'nimbus', keyword_type: 'name', keyword_match_type: 'exact' }),
    }).then((r) => r.json());
    assert.equal(miss.total, 0);
  } finally {
    await close();
  }
});

test('dealroom: website_domain search', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ keyword: 'vaultwise.de', keyword_type: 'website_domain', keyword_match_type: 'exact' }),
    }).then((r) => r.json());
    assert.equal(res.total, 1);
    assert.equal(res.items[0].name, 'Vaultwise');
  } finally {
    await close();
  }
});

test('dealroom: terms filter (industries) and range filter (launch_year_min)', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const byIndustry = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ form_data: { must: { industries: ['HealthTech'] } }, limit: 100 }),
    }).then((r) => r.json());
    assert.equal(byIndustry.total, 3); // Carewave, Curely, Pulsegrid
    assert.ok(byIndustry.items.every((c: { industries: { name: string }[] }) => c.industries.some((i) => i.name === 'HealthTech')));

    const byLaunchYear = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ form_data: { must: { launch_year_min: 2023 } }, limit: 100 }),
    }).then((r) => r.json());
    assert.ok(byLaunchYear.total > 0);
    assert.ok(byLaunchYear.items.every((c: { launch_year: number }) => c.launch_year >= 2023));
  } finally {
    await close();
  }
});

test('dealroom: sort + limit/offset', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ sort: 'name', limit: 3, offset: 1 }),
    }).then((r) => r.json());
    assert.equal(res.total, 8);
    assert.equal(res.items.length, 3);
    const names = res.items.map((c: { name: string }) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));

    const desc = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ sort: '-name', limit: 1 }),
    }).then((r) => r.json());
    assert.equal(desc.items[0].name, 'Vaultwise'); // last alphabetically among the 8 seeded names
  } finally {
    await close();
  }
});

test('dealroom: offset + limit beyond 10,000 is a 400', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ limit: 10, offset: 9995 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /bulk/);
  } finally {
    await close();
  }
});

test('dealroom: get by numeric id and by path slug', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const byId = await fetch(`${baseUrl}/dealroom/companies/1`, { headers: basicAuth() }).then((r) => r.json());
    assert.equal(byId.name, 'Nimbusly');

    const byPath = await fetch(`${baseUrl}/dealroom/companies/nimbusly`, { headers: basicAuth() }).then((r) => r.json());
    assert.equal(byPath.id, byId.id);

    const missing = await fetch(`${baseUrl}/dealroom/companies/does-not-exist`, { headers: basicAuth() });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test('dealroom: sub-resource listing with pagination (company fundings)', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const page1 = await fetch(`${baseUrl}/dealroom/companies/1/fundings?limit=1&offset=0`, { headers: basicAuth() }).then((r) => r.json());
    assert.equal(page1.total, 2); // Nimbusly has 2 rounds seeded
    assert.equal(page1.items.length, 1);

    const page2 = await fetch(`${baseUrl}/dealroom/companies/1/fundings?limit=1&offset=1`, { headers: basicAuth() }).then((r) => r.json());
    assert.equal(page2.items.length, 1);
    assert.notEqual(page1.items[0].id, page2.items[0].id);
  } finally {
    await close();
  }
});

test('dealroom: admin seed creates a round that appears in /transactions with created_utc_min', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const checkpoint = '2026-09-16 00:00:00';
    const seedRes = await fetch(`${baseUrl}/admin/dealroom/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entities: [
          {
            entity_type: 'round',
            id: '9001',
            data: {
              id: '9001', companyId: '1', date: '2026-09-16', year: 2026, month: 9,
              amount: 5, amount_source: 5_000_000, currency: 'USD', round: 'series a', standardised_round_label: 'Series A',
              valuation: 30, is_verified: true, is_undisclosed: false, news_source: null, unknown_investors: [],
              amount_eur_million: 4.6, amount_usd_million: 5,
              last_updated: '2026-09-16T12:00:00+00:00', last_updated_utc: '2026-09-16 12:00:00', created_utc: '2026-09-16 12:00:00',
            },
          },
        ],
      }),
    });
    assert.equal(seedRes.status, 200);

    const polled = await fetch(`${baseUrl}/dealroom/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({ form_data: { must: { created_utc_min: checkpoint } }, limit: 100 }),
    }).then((r) => r.json());
    assert.equal(polled.total, 1);
    assert.equal(polled.items[0].id, 9001);
    assert.equal(polled.items[0].company.name, 'Nimbusly');
  } finally {
    await close();
  }
});

test('dealroom: every call is recorded in the request log, and one entity type clears on its own', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth() },
      body: JSON.stringify({
        keyword: 'Nimbusly',
        keyword_type: 'name',
        keyword_match_type: 'exact',
        form_data: { must: { industries: ['Fintech'] } },
        sort: '-total_funding',
        limit: 3,
        offset: 0,
      }),
    });

    // The log is what proves a WHERE/ORDER BY reached Dealroom rather than
    // being applied to the response afterwards.
    const logged = (await fetch(`${baseUrl}/admin/dealroom/request_log/state`).then((r) => r.json())) as {
      method: string;
      path: string;
      body: Record<string, unknown>;
    }[];
    assert.equal(logged.length, 1);
    assert.equal(logged[0].method, 'POST');
    assert.equal(logged[0].path, '/companies');
    assert.equal(logged[0].body.keyword, 'Nimbusly');
    assert.equal(logged[0].body.sort, '-total_funding');
    assert.deepEqual(logged[0].body.form_data, { must: { industries: ['Fintech'] } });

    // An unauthenticated call never reaches the log — the auth gate runs first.
    await fetch(`${baseUrl}/dealroom/companies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(((await fetch(`${baseUrl}/admin/dealroom/request_log/state`).then((r) => r.json())) as unknown[]).length, 1);

    const cleared = await fetch(`${baseUrl}/admin/dealroom/request_log/state`, { method: 'DELETE' }).then((r) => r.json());
    assert.equal(cleared.deleted, 1);
    assert.equal(((await fetch(`${baseUrl}/admin/dealroom/request_log/state`).then((r) => r.json())) as unknown[]).length, 0);
    // Clearing one entity type leaves the rest of the service alone.
    const companies = (await fetch(`${baseUrl}/admin/dealroom/company/state`).then((r) => r.json())) as unknown[];
    assert.equal(companies.length, 8);
  } finally {
    await close();
  }
});
