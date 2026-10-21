import { Router } from 'express';
import type { Entity, EntityStore } from '../store';

const SVC = 'evertrace';
const API_VERSION = '2026-03-11';
const WORKSPACE_ID = 'ws_dev_loop';

/**
 * Fake Evertrace API — reproduces the shapes in
 * plans/evertrace-adapter-2026-09-03/1_api_digest.md closely enough to
 * exercise the adapter's WHERE pushdown, pagination, idempotent writes and
 * the version/auth gate a real client hitting production would trip.
 *
 * Scope (matches the adapter's graph — see 0_mission.md "Deliberately not
 * surfaced"): signals list/byId/entries, searches CRUD + signals, lists CRUD,
 * listEntries list/byId/create/delete, companies/educations list, screen/
 * unscreen, markAsViewed. CSV downloads, `signals.count`,
 * `signals.listByLinkedinId`, `searches.duplicate/notificationsById`,
 * `cities.list` and the `*.count` endpoints are out of scope — nothing in the
 * adapter's graph calls them.
 *
 * Every stored row carries its own `id` field (so a handler can `res.json`
 * `row.data` directly) — the same convention granola.ts uses for its notes.
 */

const STUB_USER = {
  id: 'usr_1',
  name: 'Dev Loop User',
  firstName: 'Dev Loop',
  lastName: 'User',
  email: 'dev-loop@listen-fire.local',
  emailVerified: true,
  inviterId: null,
  image: null,
  workspaceId: WORKSPACE_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  onboardedAt: '2026-01-01T00:00:00.000Z',
  role: 'ws_owner' as const,
};

/** A sharee is stored as a bare id/email string; dressed as a minimal User on
 *  read (real sharees are workspace members — the fake has exactly one). */
function shareeUser(idOrEmail: string) {
  return {
    ...STUB_USER,
    id: idOrEmail,
    name: idOrEmail,
    email: idOrEmail.includes('@') ? idOrEmail : STUB_USER.email,
  };
}

interface SignalFilter {
  created_after?: string;
  score?: string;
  fullname?: string;
  type?: string[];
  country?: string[];
  city?: string[];
  gender?: string[];
  /** `[from]` or `[from, to]` — the API allows a lone start date. */
  time_range?: string[];
}

function pageLimit(page: unknown, limit: unknown): { page: number; limit: number } {
  const p = Number(typeof page === 'string' && page ? page : '1');
  const l = Number(typeof limit === 'string' && limit ? limit : '25');
  return { page: Number.isFinite(p) && p > 0 ? p : 1, limit: Number.isFinite(l) && l > 0 ? l : 25 };
}

function paginate<T>(items: T[], page: number, limit: number): { data: T[]; meta: { page: number; limit: number } } {
  const start = (page - 1) * limit;
  return { data: items.slice(start, start + limit), meta: { page, limit } };
}

function arrayify(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/** country/city take `!name` to exclude and `"N/A"` to mean "no value". */
function matchesLocationField(value: string | null, values?: string[]): boolean {
  if (!values || values.length === 0) return true;
  const include: string[] = [];
  const exclude: string[] = [];
  for (const v of values) (v.startsWith('!') ? exclude.push(v.slice(1)) : include.push(v));
  const current = value ?? 'N/A';
  if (include.length > 0 && !include.includes(current)) return false;
  if (exclude.length > 0 && exclude.includes(current)) return false;
  return true;
}

function applySignalFilter(rows: Entity[], filter: SignalFilter): Entity[] {
  return rows.filter((row) => {
    const d = row.data as Record<string, unknown>;
    if (filter.created_after && !(Number(d.createdAt) > Number(filter.created_after))) return false;
    if (filter.score && !(Number(d.score) >= Number(filter.score))) return false;
    if (filter.fullname) {
      const full = `${(d.firstName as string) ?? ''} ${(d.lastName as string) ?? ''}`.toLowerCase();
      if (!full.includes(filter.fullname.toLowerCase())) return false;
    }
    if (filter.type && filter.type.length > 0) {
      const taggings = (d.taggings as { key: string; namespace: string }[] | undefined) ?? [];
      if (!taggings.some((t) => t.namespace === 'signal_type' && filter.type!.includes(t.key))) return false;
    }
    if (!matchesLocationField((d.country as string) ?? null, filter.country)) return false;
    if (!matchesLocationField((d.city as string) ?? null, filter.city)) return false;
    if (filter.gender && filter.gender.length > 0 && !filter.gender.includes(d.gender as string)) return false;
    if (filter.time_range && filter.time_range.length > 0) {
      const [from, to] = filter.time_range;
      const fromMs = Date.parse(`${from}T00:00:00.000Z`);
      // A lone start date leaves the range open at the top; parsing an absent
      // `to` would give NaN and drop every row.
      const toMs = to === undefined ? Infinity : Date.parse(`${to}T23:59:59.999Z`);
      const discovered = Number(d.discoveredAt);
      if (!(discovered >= fromMs && discovered <= toMs)) return false;
    }
    return true;
  });
}

/**
 * A saved search's stored filter rows, as the SignalFilter body — the same
 * translation the adapter's poll does (`status` becomes `type`, values arrive
 * as a JSON array, a JSON string, a comma-separated string or a bare one, and
 * an exclude on a `!`-capable key prefixes each value). Kept as a local
 * equivalent rather than an import: fake-channels shares no code with the API.
 *
 * ONE deliberate difference: this endpoint RUNS the whole saved search, so a
 * stored time row applies here. The poll drops those and supplies its own
 * `created_after` instead.
 */
type SearchListKey = 'type' | 'country' | 'city' | 'gender';

const SEARCH_BODY_KEY: Record<string, SearchListKey> = {
  status: 'type',
  country: 'country',
  city: 'city',
  gender: 'gender',
};
const SEARCH_EXCLUDABLE = new Set(['country', 'city', 'industry', 'origin', 'region']);
const SEARCH_INCLUDE_OPERATORS = new Set([
  '', 'eq', 'equals', 'in', 'is', 'includes', '=', '==', 'contains', 'any',
]);
const SEARCH_EXCLUDE_OPERATORS = new Set([
  'neq', 'ne', 'not', 'not_in', 'notin', 'excludes', 'is_not', '!=', '<>',
]);
const SEARCH_SCORE_INCLUDE_OPERATORS = new Set(['gte', '>=', 'min']);

function searchRowSense(operator: string | undefined, key: string): 'include' | 'exclude' | undefined {
  const op = (operator ?? '').trim().toLowerCase();
  if (SEARCH_INCLUDE_OPERATORS.has(op)) return 'include';
  if (key === 'score' && SEARCH_SCORE_INCLUDE_OPERATORS.has(op)) return 'include';
  if (SEARCH_EXCLUDE_OPERATORS.has(op) || op.startsWith('not') || op.startsWith('!')) return 'exclude';
  return undefined;
}

function searchRowValues(raw: string): string[] {
  const value = (raw ?? '').trim();
  if (value === '') return [];
  if (value.startsWith('[') || value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.trim()).filter(Boolean);
      if (typeof parsed === 'string') return parsed.trim() ? [parsed.trim()] : [];
    } catch {
      // Not JSON after all — read it as a bare value.
    }
  }
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

function signalFilterFromSearchRows(rows: { key: string; operator?: string; value: string }[]): SignalFilter {
  const filter: SignalFilter = {};
  for (const row of rows) {
    const key = (row.key ?? '').trim();
    const sense = searchRowSense(row.operator, key);
    if (sense === undefined) continue;

    if (key === 'score') {
      if (sense === 'include' && row.value) filter.score = row.value.replace(/^"|"$/g, '');
      continue;
    }
    if (key === 'created_after') {
      if (sense === 'include' && row.value) filter.created_after = row.value;
      continue;
    }
    if (key === 'time_range') {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed) && (parsed.length === 1 || parsed.length === 2)) {
          filter.time_range = parsed.map(String);
        }
      } catch {
        // Malformed stored value — ignore rather than throw on a read.
      }
      continue;
    }

    const bodyKey = SEARCH_BODY_KEY[key];
    if (bodyKey === undefined) continue;
    if (sense === 'exclude' && !SEARCH_EXCLUDABLE.has(key)) continue;
    const values = searchRowValues(row.value);
    if (values.length === 0) continue;
    const marked = sense === 'exclude' ? values.map((v) => (v.startsWith('!') ? v : `!${v}`)) : values;
    filter[bodyKey] = [...(filter[bodyKey] ?? []), ...marked];
  }
  return filter;
}

/** Every scalar field a Signal carries through `createdAt` — the trimmed
 *  shape (`lists.byId` → `entries[].signal`) is exactly this subset; the full
 *  shape adds the relational/computed fields below. */
const SIGNAL_SCALAR_FIELDS = [
  'id', 'score', 'source', 'firstName', 'lastName', 'imageUrl', 'nationality',
  'description', 'city', 'country', 'gender', 'githubSlug', 'linkedinIdIm',
  'linkedinIdStr', 'signalHash', 'profileAccuracy', 'age', 'discoveredAt',
  'twitterId', 'email', 'stealthSign', 'stealthReason', 'summary', 'createdAt',
] as const;

function buildTrimmedSignal(row: Entity): Record<string, unknown> {
  const d = row.data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SIGNAL_SCALAR_FIELDS) out[key] = key === 'id' ? row.id : d[key];
  return out;
}

function dressSignalEvent(row: Entity, includeUser: boolean): Record<string, unknown> {
  const d = row.data as Record<string, unknown>;
  return {
    id: row.id,
    workspaceId: WORKSPACE_ID,
    createdBy: d.createdBy ?? STUB_USER.id,
    signalId: d.signalId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(includeUser ? { createdByUser: STUB_USER } : {}),
  };
}

function buildFullSignal(store: EntityStore, row: Entity): Record<string, unknown> {
  const screening = store.get(SVC, 'screening', row.id);
  const view = store.get(SVC, 'view', row.id);
  const listPresence = store.list(SVC, 'listEntry').some((e) => e.data.signalId === row.id);
  return {
    ...row.data,
    id: row.id,
    screenings: screening ? [dressSignalEvent(screening, true)] : [],
    views: view ? [dressSignalEvent(view, true)] : [],
    listPresence,
  };
}

export function evertraceRoutes(store: EntityStore): Router {
  const r = Router();

  // Auth + version gate, enforced on every route — the point is that a
  // client which forgets `X-API-Version` (or the header string drifts) fails
  // in the dev loop the same way it would against production.
  r.use((req, res, next) => {
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return res.status(401).end();
    const version = req.headers['x-api-version'];
    if (version === undefined) return res.status(400).json({ _tag: 'MissingApiVersionError' });
    if (version !== API_VERSION) return res.status(400).json({ _tag: 'UnsupportedApiVersionError' });
    next();
  });

  // ── signals ────────────────────────────────────────────────
  r.post('/signals', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filter: SignalFilter = {
      created_after: body.created_after as string | undefined,
      score: body.score as string | undefined,
      fullname: body.fullname as string | undefined,
      type: body.type as string[] | undefined,
      country: body.country as string[] | undefined,
      city: body.city as string[] | undefined,
      gender: body.gender as string[] | undefined,
      time_range: body.time_range as string[] | undefined,
    };
    const rows = applySignalFilter(store.list(SVC, 'signal'), filter);
    const { page, limit } = pageLimit(body.page, body.limit);
    res.json(paginate(rows.map((row) => buildFullSignal(store, row)), page, limit));
  });

  r.get('/signals/:id', (req, res) => {
    const row = store.get(SVC, 'signal', req.params.id);
    if (!row) return res.status(404).json({ _tag: 'SignalNotFoundError' });
    res.json(buildFullSignal(store, row));
  });

  r.get('/signals/:id/entries', (req, res) => {
    const entries = store
      .list(SVC, 'listEntry')
      .filter((e) => e.data.signalId === req.params.id)
      .map((e) => ({ ...e.data, id: e.id }));
    res.json(entries);
  });

  // ── searches ───────────────────────────────────────────────
  function dressSearch(row: Entity) {
    const d = row.data as Record<string, unknown>;
    return { ...d, id: row.id, sharees: ((d.sharees as string[]) ?? []).map(shareeUser) };
  }

  r.get('/searches', (_req, res) => {
    res.json(store.list(SVC, 'search').map(dressSearch));
  });

  r.post('/searches', (req, res) => {
    const id = store.nextId(SVC, 'search');
    const now = Date.now();
    const filters = ((req.body.filters ?? []) as { key: string; operator: string; value: string }[]).map(
      (f, i) => ({
        id: `sfr_${id}_${i}`,
        searchId: id,
        key: f.key,
        operator: f.operator,
        value: f.value,
        workspaceId: WORKSPACE_ID,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const row = store.create(
      SVC,
      'search',
      {
        workspaceId: WORKSPACE_ID,
        emoji: req.body.emoji ?? null,
        title: req.body.title,
        createdBy: STUB_USER.id,
        updatedBy: STUB_USER.id,
        createdAt: now,
        updatedAt: now,
        visitedAt: req.body.visitedAt ?? now,
        visitedBy: STUB_USER.id,
        orderIndex: '0',
        filters,
        sharees: req.body.sharees ?? [],
      },
      id,
    );
    res.json(dressSearch(row));
  });

  r.get('/searches/:id', (req, res) => {
    const row = store.get(SVC, 'search', req.params.id);
    if (!row) return res.status(404).json({ _tag: 'SearchNotFoundError' });
    res.json(dressSearch(row));
  });

  r.put('/searches/:id', (req, res) => {
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now, updatedBy: STUB_USER.id };
    if (req.body.title !== undefined) patch.title = req.body.title;
    if (req.body.emoji !== undefined) patch.emoji = req.body.emoji;
    if (req.body.visitedAt !== undefined) patch.visitedAt = req.body.visitedAt;
    if (req.body.sharees !== undefined) patch.sharees = req.body.sharees;
    if (req.body.filters !== undefined) {
      patch.filters = (req.body.filters as { key: string; operator: string; value: string }[]).map(
        (f, i) => ({
          id: `sfr_${req.params.id}_${i}`,
          searchId: req.params.id,
          key: f.key,
          operator: f.operator,
          value: f.value,
          workspaceId: WORKSPACE_ID,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    const row = store.update(SVC, 'search', req.params.id, patch);
    if (!row) return res.status(404).json({ _tag: 'SearchNotFoundError' });
    res.json(dressSearch(row));
  });

  r.delete('/searches/:id', (req, res) => {
    const row = store.get(SVC, 'search', req.params.id);
    if (!row) return res.status(404).json({ _tag: 'SearchNotFoundError' });
    store.delete(SVC, 'search', req.params.id);
    res.json(dressSearch(row));
  });

  r.get('/searches/:id/signals', (req, res) => {
    const row = store.get(SVC, 'search', req.params.id);
    if (!row) return res.status(404).json({ _tag: 'SearchNotFoundError' });
    const filter = signalFilterFromSearchRows(
      (row.data.filters as { key: string; operator?: string; value: string }[]) ?? [],
    );
    const rows = applySignalFilter(store.list(SVC, 'signal'), filter);
    const { page, limit } = pageLimit(req.query.page, req.query.limit);
    res.json(paginate(rows.map((sig) => buildFullSignal(store, sig)), page, limit));
  });

  // ── companies / educations ────────────────────────────────
  r.get('/companies', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : undefined;
    const ids = arrayify(req.query.ids);
    let rows = store.list(SVC, 'company').map((row) => row.data as Record<string, unknown>);
    if (ids) rows = rows.filter((c) => ids.includes(c.id as string));
    else if (search) rows = rows.filter((c) => ((c.name as string) ?? '').toLowerCase().includes(search));
    rows = [...rows].sort((a, b) => ((b.employeeCount as number) ?? 0) - ((a.employeeCount as number) ?? 0));
    const { page, limit } = pageLimit(req.query.page, req.query.limit);
    res.json(paginate(rows, page, limit));
  });

  r.get('/educations', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : undefined;
    const ids = arrayify(req.query.ids);
    let rows = store.list(SVC, 'education').map((row) => row.data as Record<string, unknown>);
    if (ids) rows = rows.filter((e) => ids.includes(e.id as string));
    else if (search) rows = rows.filter((e) => ((e.name as string) ?? '').toLowerCase().includes(search));
    rows = [...rows].sort((a, b) => ((b.studentCount as number) ?? 0) - ((a.studentCount as number) ?? 0));
    const { page, limit } = pageLimit(req.query.page, req.query.limit);
    res.json(paginate(rows, page, limit));
  });

  // ── lists ──────────────────────────────────────────────────
  function entriesCount(listId: string): number {
    return store.list(SVC, 'listEntry').filter((e) => e.data.listId === listId).length;
  }

  function dressList(row: Entity, withEntries: boolean) {
    const base = { ...row.data, id: row.id, entriesCount: entriesCount(row.id), creator: STUB_USER, accesses: [] };
    if (!withEntries) return base;
    const entries = store
      .list(SVC, 'listEntry')
      .filter((e) => e.data.listId === row.id)
      .map((e) => {
        const signalRow = store.get(SVC, 'signal', e.data.signalId as string);
        return {
          ...e.data,
          id: e.id,
          signal: signalRow ? buildTrimmedSignal(signalRow) : null,
        };
      });
    return { ...base, entries };
  }

  r.get('/lists', (_req, res) => {
    res.json(store.list(SVC, 'list').map((row) => dressList(row, false)));
  });

  r.post('/lists', (req, res) => {
    const id = store.nextId(SVC, 'list');
    const now = Date.now();
    const row = store.create(
      SVC,
      'list',
      { workspaceId: WORKSPACE_ID, createdBy: STUB_USER.id, name: req.body.name, createdAt: now, updatedAt: now },
      id,
    );
    res.json(dressList(row, false));
  });

  r.get('/lists/:id', (req, res) => {
    const row = store.get(SVC, 'list', req.params.id);
    if (!row) return res.status(404).json({ _tag: 'ListNotFoundError' });
    res.json(dressList(row, true));
  });

  r.put('/lists/:id', (req, res) => {
    const row = store.update(SVC, 'list', req.params.id, {
      ...(req.body.name !== undefined ? { name: req.body.name } : {}),
      updatedAt: Date.now(),
    });
    if (!row) return res.status(404).json({ _tag: 'ListNotFoundError' });
    res.json(dressList(row, false));
  });

  r.delete('/lists/:id', (req, res) => {
    const row = store.get(SVC, 'list', req.params.id);
    if (!row) return res.status(404).json({ _tag: 'ListNotFoundError' });
    store.delete(SVC, 'list', req.params.id);
    res.json(dressList(row, false));
  });

  // ── list entries ───────────────────────────────────────────
  function dressEntry(row: Entity) {
    const signalRow = store.get(SVC, 'signal', row.data.signalId as string);
    return {
      ...row.data,
      id: row.id,
      signal: signalRow ? buildFullSignal(store, signalRow) : null,
      addedByUser: STUB_USER,
    };
  }

  r.get('/lists/:listId/entries', (req, res) => {
    const rows = store.list(SVC, 'listEntry').filter((e) => e.data.listId === req.params.listId);
    const sortBy = req.query.sort_by === 'signal_discovered_at' ? 'signal_discovered_at' : 'entry_created_at';
    const order = req.query.sort_order === 'asc' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      const av = sortBy === 'entry_created_at' ? (a.data.createdAt as number) : (store.get(SVC, 'signal', a.data.signalId as string)?.data.discoveredAt as number) ?? 0;
      const bv = sortBy === 'entry_created_at' ? (b.data.createdAt as number) : (store.get(SVC, 'signal', b.data.signalId as string)?.data.discoveredAt as number) ?? 0;
      return order * (av - bv);
    });
    const { page, limit } = pageLimit(req.query.page, req.query.limit);
    res.json(paginate(sorted.map(dressEntry), page, limit));
  });

  r.post('/lists/:listId/entries', (req, res) => {
    const listId = req.params.listId;
    const signalId = req.body.signalId as string;
    const existing = store.list(SVC, 'listEntry').find((e) => e.data.listId === listId && e.data.signalId === signalId);
    if (existing) return res.status(200).json(dressEntry(existing));

    const id = store.nextId(SVC, 'listEntry');
    const now = Date.now();
    const row = store.create(
      SVC,
      'listEntry',
      { workspaceId: WORKSPACE_ID, listId, signalId, addedBy: STUB_USER.id, createdAt: now, updatedAt: now },
      id,
    );
    res.status(201).json(dressEntry(row));
  });

  r.get('/lists/:listId/entries/:entryId', (req, res) => {
    const row = store.get(SVC, 'listEntry', req.params.entryId);
    if (!row || row.data.listId !== req.params.listId) return res.status(404).json({ _tag: 'ListEntryNotFoundError' });
    res.json(dressEntry(row));
  });

  r.delete('/lists/:listId/entries/:entryId', (req, res) => {
    const row = store.get(SVC, 'listEntry', req.params.entryId);
    if (!row || row.data.listId !== req.params.listId) return res.status(404).json({ _tag: 'ListEntryNotFoundError' });
    store.delete(SVC, 'listEntry', req.params.entryId);
    res.json({ ...row.data, id: row.id });
  });

  // ── screenings / views ─────────────────────────────────────
  r.post('/signals/:signalId/screenings', (req, res) => {
    const signalId = req.params.signalId;
    const existing = store.get(SVC, 'screening', signalId);
    if (existing) return res.json(dressSignalEvent(existing, true));
    const now = Date.now();
    const row = store.create(SVC, 'screening', { workspaceId: WORKSPACE_ID, createdBy: STUB_USER.id, signalId, createdAt: now, updatedAt: now }, signalId);
    res.json(dressSignalEvent(row, true));
  });

  r.delete('/signals/:signalId/screenings', (req, res) => {
    const row = store.get(SVC, 'screening', req.params.signalId);
    if (!row) return res.status(404).json({ _tag: 'ScreeningNotFoundError' });
    store.delete(SVC, 'screening', req.params.signalId);
    res.json(dressSignalEvent(row, false));
  });

  r.post('/views/:signalId', (req, res) => {
    const signalId = req.params.signalId;
    const existing = store.get(SVC, 'view', signalId);
    if (existing) return res.json(dressSignalEvent(existing, true));
    const now = Date.now();
    const row = store.create(SVC, 'view', { workspaceId: WORKSPACE_ID, createdBy: STUB_USER.id, signalId, createdAt: now, updatedAt: now }, signalId);
    res.json(dressSignalEvent(row, true));
  });

  return r;
}
