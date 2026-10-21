import { Router } from 'express';
import type { Entity, EntityStore } from '../store';

const SVC = 'dealroom';

/**
 * Fake Dealroom Premium API — reproduces the shapes in
 * plans/dealroom-adapter-2026-09-16/1_api_digest.md closely enough to
 * exercise the adapter's keyword search, WHERE pushdown (form_data
 * must/should/must_not), sort, pagination (incl. the 10,000-offset cap),
 * get-by-id-or-path, batch and the sub-resource walks the adapter's graph
 * uses (see 0_mission.md "The graph").
 *
 * Scope (matches the adapter's graph): companies/investors/founders/
 * transactions search + get + batch, the company and investor sub-resource
 * endpoints the mission lists. Bulk (cursor-paginated), dump, filters
 * catalogue, analytics, news, lookup/locations, removed/gdpr and the notify
 * endpoints are out of scope — nothing in the adapter's graph calls them.
 *
 * Storage: every entity type (`company`, `investor`, `person`, `round`) is
 * stored as its own scalar+array-of-param row; relations between them
 * (`round_investor`, `company_investor`, `team_membership`, `fund`) are
 * their own join rows, so nothing is duplicated between an entity and its
 * relations — the same normalize-then-dress shape evertrace.ts uses for
 * signals/lists/entries.
 */

// ── shared shapes ─────────────────────────────────────────────────────────

/** `city`, `country` and `continent` are Shared_Param objects (`{id,name}`),
 *  not bare strings — the same nested shape every other taxonomy value on a
 *  Dealroom entity carries. */
interface LocationRow {
  id: number;
  is_headquarters: boolean;
  is_founding_location: boolean;
  address: string | null;
  street: string | null;
  street_number: string | null;
  zip: string | null;
  lat: number | null;
  lon: number | null;
  continent: { id: number; name: string } | null;
  country: { id: number; name: string } | null;
  city: { id: number; name: string } | null;
}

interface FormData {
  must?: Record<string, unknown>;
  should?: Record<string, unknown>;
  must_not?: Record<string, unknown>;
}

interface SearchBody {
  keyword?: string | string[];
  keyword_type: 'default' | 'default_next' | 'name' | 'website_domain';
  keyword_match_type: 'fuzzy' | 'exact' | 'all' | 'any';
  form_data: FormData;
  fields?: string;
  sort?: string;
  limit: number;
  offset: number;
}

// ── generic helpers ───────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function dressImages(seed: string): Record<string, string> {
  const enc = encodeURIComponent(seed);
  return {
    '32x32': `https://fake-dealroom.local/logos/${enc}/32x32.png`,
    '74x74': `https://fake-dealroom.local/logos/${enc}/74x74.png`,
    '100x100': `https://fake-dealroom.local/logos/${enc}/100x100.png`,
  };
}

function profileUrl(kind: 'companies' | 'investors' | 'people', path: string): string {
  return `https://app.dealroom.co/${kind}/${path}`;
}

function param(id: number, name: string): { id: number; name: string } {
  return { id, name };
}

function paramNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((p) => String((p as { name?: unknown })?.name ?? p)).filter(Boolean);
}

function embeddedList<T>(items: T[], cap = 5): { items: T[]; total: number } {
  return { items: items.slice(0, cap), total: items.length };
}

/** `"YYYY-MM-DD HH:mm:ss"` (the API's UTC timestamp format) → epoch ms. */
function toUtcMs(dateStr: string): number {
  return Date.parse(dateStr.trim().replace(' ', 'T') + 'Z');
}

function hostOf(url?: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function findByIdOrPath(store: EntityStore, entityType: string, idOrPath: string): Entity | null {
  const byId = store.get(SVC, entityType, idOrPath);
  if (byId) return byId;
  return store.list(SVC, entityType).find((e) => e.data.path === idOrPath) ?? null;
}

/** Projects to requested top-level keys (bracket-nested selections like
 *  `team(id,name)` are honoured at the top level only — `team` is kept whole;
 *  unknown fields are ignored). `id` always survives. Omitting `fields`
 *  returns everything, matching the real API's documented default. */
function projectFields<T extends Record<string, unknown>>(entity: T, fieldsParam?: string): Record<string, unknown> {
  if (!fieldsParam) return entity;
  const keys = fieldsParam
    .split(',')
    .map((f) => f.trim().split('(')[0].trim())
    .filter(Boolean);
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in entity) out[k] = entity[k];
  if (!('id' in out) && 'id' in entity) out.id = entity.id;
  return out;
}

function parseSearchBody(body: unknown): SearchBody {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    keyword: b.keyword as string | string[] | undefined,
    keyword_type: (b.keyword_type as SearchBody['keyword_type']) ?? 'default',
    keyword_match_type: (b.keyword_match_type as SearchBody['keyword_match_type']) ?? 'fuzzy',
    form_data: (b.form_data as FormData) ?? {},
    fields: b.fields as string | undefined,
    sort: b.sort as string | undefined,
    limit: typeof b.limit === 'number' ? b.limit : 10,
    offset: typeof b.offset === 'number' ? b.offset : 0,
  };
}

/** `limit`/`offset` validation, incl. the documented "beyond 10,000, use
 *  /bulk" cap. Writes the 400 response itself and returns null so callers can
 *  `if (!lo) return;`. */
function resolveLimitOffset(body: SearchBody, res: import('express').Response): { limit: number; offset: number } | null {
  if (body.limit > 100) {
    res.status(400).json({ message: 'limit must be 100 or less' });
    return null;
  }
  if (body.limit < 1) {
    res.status(400).json({ message: 'limit must be at least 1' });
    return null;
  }
  if (body.offset < 0) {
    res.status(400).json({ message: 'offset must be 0 or greater' });
    return null;
  }
  if (body.limit + body.offset > 10000) {
    res.status(400).json({
      message: 'offset + limit exceeds the maximum of 10000 — use the corresponding /bulk endpoint to export beyond this range.',
    });
    return null;
  }
  return { limit: body.limit, offset: body.offset };
}

function matchesKeyword(name: string, websiteUrl: string | null | undefined, body: SearchBody): boolean {
  if (!body.keyword) return true;
  const kw = String(Array.isArray(body.keyword) ? body.keyword[0] : body.keyword).toLowerCase();
  if (!kw) return true;
  const haystacks: string[] = [];
  if (body.keyword_type === 'name') haystacks.push(name);
  else if (body.keyword_type === 'website_domain') haystacks.push(hostOf(websiteUrl));
  else haystacks.push(name, hostOf(websiteUrl)); // 'default' and 'default_next' (all/any not modelled — fuzzy fallback)
  const norm = haystacks.filter(Boolean).map((h) => h.toLowerCase());
  if (body.keyword_match_type === 'exact') return norm.some((h) => h === kw);
  return norm.some((h) => h.includes(kw));
}

function applySort(
  rows: Record<string, unknown>[],
  sort: string | undefined,
  getters: Record<string, (c: Record<string, unknown>) => number | string>,
): Record<string, unknown>[] {
  if (!sort) return rows;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  const getter = getters[key];
  if (!getter) return rows;
  const sorted = [...rows].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv));
    return (av as number) - (bv as number);
  });
  return desc ? sorted.reverse() : sorted;
}

// ── form_data filter matchers ───────────────────────────────────────────

function termsToArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return [];
  return [String(value)];
}

function matchesTerms(fieldValues: string[], wanted: unknown): boolean {
  const want = termsToArray(wanted).map((w) => w.toLowerCase());
  if (want.length === 0) return true;
  const have = fieldValues.map((v) => v.toLowerCase());
  return want.some((w) => have.includes(w));
}

/** GUESSED: `hq_locations` (and founders' `locations`) match city, country or
 *  address as a case-insensitive substring, any-of the requested strings —
 *  the spec gives no worked example for this filter. */
function matchesLocationText(locations: unknown, wanted: unknown): boolean {
  const want = termsToArray(wanted).map((w) => w.toLowerCase());
  if (want.length === 0) return true;
  const rows = (locations as LocationRow[] | undefined) ?? [];
  const haystacks = rows
    .flatMap((l) => [l.city?.name, l.country?.name, l.address])
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase());
  return want.some((w) => haystacks.some((h) => h.includes(w)));
}

function matchesDateMin(fieldValue: string | undefined | null, bound: unknown): boolean {
  if (bound == null) return true;
  if (!fieldValue) return false;
  return toUtcMs(fieldValue) >= toUtcMs(String(bound));
}

function matchesDateMax(fieldValue: string | undefined | null, bound: unknown): boolean {
  if (bound == null) return true;
  if (!fieldValue) return false;
  return toUtcMs(fieldValue) <= toUtcMs(String(bound));
}

function matchesRangeMin(value: number | undefined | null, bound: unknown): boolean {
  if (bound == null) return true;
  if (value == null) return false;
  return value >= Number(bound);
}

function matchesRangeMax(value: number | undefined | null, bound: unknown): boolean {
  if (bound == null) return true;
  if (value == null) return false;
  return value <= Number(bound);
}

/** GUESSED: a boolean filter (`is_verified`, `is_strong_founder`, …) accepts
 *  a bare boolean, `"true"`/`"false"`, or a one-element terms array of either
 *  — the spec documents these as booleans on the entity but doesn't show the
 *  filter's wire shape. */
function matchesBool(value: boolean | undefined, wanted: unknown): boolean {
  const raw = Array.isArray(wanted) ? wanted[0] : wanted;
  if (raw == null) return true;
  const want = raw === true || raw === 'true' || raw === 1 || raw === '1';
  return Boolean(value) === want;
}

type FilterChecks = Record<string, (v: unknown) => boolean>;

function applyFormData(checks: FilterChecks, formData: FormData): boolean {
  for (const [k, v] of Object.entries(formData.must ?? {})) {
    const fn = checks[k];
    if (fn && !fn(v)) return false;
  }
  for (const [k, v] of Object.entries(formData.must_not ?? {})) {
    const fn = checks[k];
    if (fn && fn(v)) return false;
  }
  const shouldEntries = Object.entries(formData.should ?? {});
  if (shouldEntries.length > 0) {
    const anyMatch = shouldEntries.some(([k, v]) => {
      const fn = checks[k];
      return fn ? fn(v) : false;
    });
    if (!anyMatch) return false;
  }
  return true;
}

// ── seed-time constructors (used by seed.ts) ────────────────────────────

export function mkLocation(input: {
  id: number;
  city: string;
  country: string;
  continent: string;
  address?: string;
  lat?: number;
  lon?: number;
  isHq?: boolean;
}): LocationRow {
  return {
    id: input.id,
    is_headquarters: input.isHq ?? true,
    is_founding_location: input.isHq ?? true,
    address: input.address ?? `${input.city}, ${input.country}`,
    street: null,
    street_number: null,
    zip: null,
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    // Dealroom numbers each location part of its own; derived here so a seeded
    // location needs only the names.
    continent: { id: input.id * 10 + 1, name: input.continent },
    country: { id: input.id * 10 + 2, name: input.country },
    city: { id: input.id * 10 + 3, name: input.city },
  };
}

export function mkParams(names: string[], startId: number): { id: number; name: string }[] {
  return names.map((name, i) => param(startId + i, name));
}

// ── company ────────────────────────────────────────────────────────────

function companyRounds(store: EntityStore, companyId: string): Entity[] {
  return store.list(SVC, 'round').filter((r) => r.data.companyId === companyId);
}

function companyTeam(store: EntityStore, companyId: string): Entity[] {
  return store.list(SVC, 'team_membership').filter((tm) => tm.data.orgType === 'company' && tm.data.orgId === companyId);
}

function companyInvestorRows(store: EntityStore, companyId: string): Entity[] {
  return store.list(SVC, 'company_investor').filter((ci) => ci.data.companyId === companyId);
}

function dressTeamMember(store: EntityStore, tm: Entity): Record<string, unknown> {
  const person = store.get(SVC, 'person', tm.data.personId as string);
  const titles = (tm.data.titles as { name: string }[]) ?? [];
  return {
    id: Number(person?.id),
    type: 'person',
    name: person?.data.name,
    path: person?.data.path,
    url: profileUrl('people', person?.data.path as string),
    images: dressImages(`person-${person?.id}`),
    linkedin_url: person?.data.linkedin_url ?? null,
    titles,
    raw_titles: titles.map((t) => t.name).join(', ') || null,
    past: tm.data.past,
    is_founder: tm.data.is_founder,
    is_executive: tm.data.is_executive,
    is_partner: tm.data.is_partner,
    year_start: tm.data.year_start,
    year_end: tm.data.year_end,
  };
}

function dressFundingInvestor(store: EntityStore, ri: Entity): Record<string, unknown> {
  const investor = store.get(SVC, 'investor', ri.data.investorId as string);
  return {
    id: Number(investor?.id),
    type: 'investor',
    name: investor?.data.name,
    path: investor?.data.path,
    url: profileUrl('investors', investor?.data.path as string),
    images: dressImages(`investor-${investor?.id}`),
    lead: ri.data.lead,
  };
}

/** V1_BaseFunding — no `company` (the caller already knows which company). */
function dressBaseFunding(store: EntityStore, round: Entity): Record<string, unknown> {
  const d = round.data;
  const investors = store
    .list(SVC, 'round_investor')
    .filter((ri) => ri.data.roundId === round.id)
    .map((ri) => dressFundingInvestor(store, ri));
  return {
    id: Number(round.id),
    year: d.year,
    month: d.month,
    amount: d.amount,
    amount_source: d.amount_source,
    currency: d.currency,
    round: d.round,
    standardised_round_label: d.standardised_round_label,
    valuation: d.valuation,
    is_verified: d.is_verified,
    is_undisclosed: d.is_undisclosed,
    news_source: d.news_source,
    unknown_investors: d.unknown_investors ?? [],
    amount_eur_million: d.amount_eur_million,
    amount_usd_million: d.amount_usd_million,
    last_updated: d.last_updated,
    last_updated_utc: d.last_updated_utc,
    created_utc: d.created_utc,
    deleted: false,
    investors,
  };
}

function dressCompanyInvestor(store: EntityStore, ci: Entity): Record<string, unknown> {
  const investor = store.get(SVC, 'investor', ci.data.investorId as string);
  return {
    id: Number(investor?.id),
    type: 'investor',
    name: investor?.data.name,
    path: investor?.data.path,
    url: profileUrl('investors', investor?.data.path as string),
    images: dressImages(`investor-${investor?.id}`),
    exited: ci.data.exited,
    lead: ci.data.lead,
  };
}

function companyLatestRound(store: EntityStore, companyId: string): Entity | undefined {
  const rounds = [...companyRounds(store, companyId)].sort((a, b) => (a.data.date as string).localeCompare(b.data.date as string));
  return rounds[rounds.length - 1];
}

/** Full `V1_Company` view, with `team`/`investors`/`fundings` embedded and
 *  capped at 5 items (the search/get-by-id cap the digest documents) — the
 *  dedicated sub-resource routes below return the uncapped list. */
function companyView(store: EntityStore, row: Entity): Record<string, unknown> {
  const d = row.data;
  const rounds = companyRounds(store, row.id);
  const totalFunding = Number(rounds.reduce((sum, r) => sum + (Number(r.data.amount_eur_million) || 0), 0).toFixed(2));
  const latest = companyLatestRound(store, row.id);
  const sortedFundings = [...rounds].sort((a, b) => (b.data.date as string).localeCompare(a.data.date as string));
  return {
    id: Number(row.id),
    type: 'company',
    name: d.name,
    path: d.path,
    url: profileUrl('companies', d.path as string),
    images: dressImages(`company-${row.id}`),
    tagline: d.tagline,
    about: d.about,
    website_url: d.website_url,
    linkedin_url: d.linkedin_url,
    twitter_url: d.twitter_url ?? null,
    employees: d.employees,
    employees_latest: d.employees_latest,
    growth_stage: d.growth_stage,
    company_status: d.company_status,
    total_funding: totalFunding,
    total_funding_currency: 'EUR',
    last_funding: latest ? latest.data.standardised_round_label : null,
    last_funding_date: latest ? latest.data.date : null,
    launch_year: d.launch_year,
    launch_month: d.launch_month,
    industries: d.industries,
    sub_industries: d.sub_industries,
    technologies: d.technologies,
    tags: d.tags,
    hq_locations: d.hq_locations,
    job_openings: d.job_openings,
    patents_count: d.patents_count,
    has_strong_founder: d.has_strong_founder,
    has_super_founder: d.has_super_founder,
    has_promising_founder: d.has_promising_founder,
    last_updated: d.last_updated,
    last_updated_utc: d.last_updated_utc,
    created_utc: d.created_utc,
    deleted: false,
    team: embeddedList(companyTeam(store, row.id).map((tm) => dressTeamMember(store, tm))),
    investors: embeddedList(companyInvestorRows(store, row.id).map((ci) => dressCompanyInvestor(store, ci))),
    fundings: embeddedList(sortedFundings.map((r) => dressBaseFunding(store, r))),
  };
}

function companyShortView(store: EntityStore, row: Entity): Record<string, unknown> {
  const full = companyView(store, row);
  return {
    id: full.id,
    type: full.type,
    name: full.name,
    path: full.path,
    url: full.url,
    images: full.images,
    tagline: full.tagline,
    website_url: full.website_url,
    hq_locations: full.hq_locations,
    total_funding: full.total_funding,
    total_funding_currency: full.total_funding_currency,
    total_funding_source: Math.round((full.total_funding as number) * 1_000_000),
    industries: full.industries,
    last_updated: full.last_updated,
    last_updated_utc: full.last_updated_utc,
    created_utc: full.created_utc,
  };
}

function companyMatchesFilters(c: Record<string, unknown>, formData: FormData): boolean {
  const checks: FilterChecks = {
    industries: (v) => matchesTerms(paramNames(c.industries), v),
    sub_industries: (v) => matchesTerms(paramNames(c.sub_industries), v),
    hq_locations: (v) => matchesLocationText(c.hq_locations, v),
    growth_stages: (v) => matchesTerms([String(c.growth_stage ?? '')], v),
    company_status: (v) => matchesTerms([String(c.company_status ?? '')], v),
    tags: (v) => matchesTerms(paramNames(c.tags), v),
    total_funding_min: (v) => matchesRangeMin(c.total_funding as number, v),
    total_funding_max: (v) => matchesRangeMax(c.total_funding as number, v),
    launch_year_min: (v) => matchesRangeMin(c.launch_year as number, v),
    launch_year_max: (v) => matchesRangeMax(c.launch_year as number, v),
    last_updated_utc: (v) => matchesDateMin(c.last_updated_utc as string, v),
    created_utc_min: (v) => matchesDateMin(c.created_utc as string, v),
    created_utc_max: (v) => matchesDateMax(c.created_utc as string, v),
  };
  return applyFormData(checks, formData);
}

// ── investor ───────────────────────────────────────────────────────────

function investorTeam(store: EntityStore, investorId: string): Entity[] {
  return store.list(SVC, 'team_membership').filter((tm) => tm.data.orgType === 'investor' && tm.data.orgId === investorId);
}

function investorCompanyInvestorRows(store: EntityStore, investorId: string): Entity[] {
  return store.list(SVC, 'company_investor').filter((ci) => ci.data.investorId === investorId);
}

function investorRoundRows(store: EntityStore, investorId: string): Entity[] {
  return store.list(SVC, 'round_investor').filter((ri) => ri.data.investorId === investorId);
}

function investorRounds(store: EntityStore, investorId: string): Entity[] {
  return investorRoundRows(store, investorId)
    .map((ri) => store.get(SVC, 'round', ri.data.roundId as string))
    .filter((r): r is Entity => r != null);
}

function investorShortView(row: Entity): Record<string, unknown> {
  return {
    id: Number(row.id),
    type: 'investor',
    name: row.data.name,
    path: row.data.path,
    url: profileUrl('investors', row.data.path as string),
    images: dressImages(`investor-${row.id}`),
  };
}

function dressInvestorInvestment(store: EntityStore, ci: Entity): Record<string, unknown> {
  const company = store.get(SVC, 'company', ci.data.companyId as string);
  return { ...(company ? companyShortView(store, company) : {}), exited: ci.data.exited };
}

/** V1_InvestorFundings = V1_BaseFunding + `company`. Also reused for the full
 *  `V1_Funding` transaction entity (search / get) — same shape per digest. */
function roundFullView(store: EntityStore, round: Entity): Record<string, unknown> {
  const company = store.get(SVC, 'company', round.data.companyId as string);
  return {
    ...dressBaseFunding(store, round),
    company: company ? companyShortView(store, company) : null,
  };
}

function dressFund(f: Entity): Record<string, unknown> {
  return {
    id: Number(f.id),
    fund_name: f.data.fund_name,
    fund_type: f.data.fund_type,
    amount: f.data.amount,
    currency: f.data.currency,
    is_closed: f.data.is_closed,
    date: f.data.date,
    date_utc: f.data.date_utc,
    feed_item: null,
  };
}

function coInvestorsFor(store: EntityStore, investorId: string): Entity[] {
  const myRounds = new Set(investorRoundRows(store, investorId).map((ri) => ri.data.roundId));
  const seen = new Map<string, Entity>();
  for (const ri of store.list(SVC, 'round_investor')) {
    if (ri.data.investorId === investorId) continue;
    if (!myRounds.has(ri.data.roundId)) continue;
    const inv = store.get(SVC, 'investor', ri.data.investorId as string);
    if (inv) seen.set(inv.id, inv);
  }
  return [...seen.values()];
}

function investorView(store: EntityStore, row: Entity): Record<string, unknown> {
  const d = row.data;
  const rounds = investorRounds(store, row.id);
  const totalFunding = Number(rounds.reduce((sum, r) => sum + (Number(r.data.amount_eur_million) || 0), 0).toFixed(2));
  const sortedByDate = [...rounds].sort((a, b) => (b.data.date as string).localeCompare(a.data.date as string));
  const investmentRows = investorCompanyInvestorRows(store, row.id);
  return {
    id: Number(row.id),
    type: 'investor',
    name: d.name,
    path: d.path,
    url: profileUrl('investors', d.path as string),
    images: dressImages(`investor-${row.id}`),
    investor_type: d.investor_type,
    tagline: d.tagline,
    about: d.about,
    website_url: d.website_url,
    linkedin_url: d.linkedin_url,
    employees: d.employees,
    employees_latest: d.employees_latest,
    deal_size: d.deal_size,
    launch_year: d.launch_year,
    total_funding: totalFunding,
    recent_funding: sortedByDate[0]?.data.date ?? null,
    investments_num: investmentRows.length,
    investment_stages: d.investment_stages,
    industry_experience: d.industry_experience,
    location_experience: d.location_experience,
    tags: d.tags,
    hq_locations: d.hq_locations,
    last_updated: d.last_updated,
    last_updated_utc: d.last_updated_utc,
    created_utc: d.created_utc,
    team: embeddedList(investorTeam(store, row.id).map((tm) => dressTeamMember(store, tm))),
    fundings: embeddedList(sortedByDate.map((r) => roundFullView(store, r))),
    investments: embeddedList(investmentRows.map((ci) => dressInvestorInvestment(store, ci))),
    co_investors: embeddedList(coInvestorsFor(store, row.id).map(investorShortView)),
    funds_under_management: embeddedList(
      store.list(SVC, 'fund').filter((f) => f.data.investorId === row.id).map(dressFund),
    ),
  };
}

function investorMatchesFilters(c: Record<string, unknown>, formData: FormData): boolean {
  const checks: FilterChecks = {
    investor_type: (v) => matchesTerms([String(c.investor_type ?? '')], v),
    investment_stages: (v) => matchesTerms(paramNames(c.investment_stages), v),
    industry_experience: (v) => matchesTerms(paramNames(c.industry_experience), v),
    hq_locations: (v) => matchesLocationText(c.hq_locations, v),
    last_updated_utc: (v) => matchesDateMin(c.last_updated_utc as string, v),
    created_utc_min: (v) => matchesDateMin(c.created_utc as string, v),
    created_utc_max: (v) => matchesDateMax(c.created_utc as string, v),
  };
  return applyFormData(checks, formData);
}

// ── person / founder ──────────────────────────────────────────────────

function dressUserCompany(company: Entity, tm: Entity): Record<string, unknown> {
  const titles = (tm.data.titles as { name: string }[]) ?? [];
  return {
    id: Number(company.id),
    type: 'company',
    name: company.data.name,
    path: company.data.path,
    url: profileUrl('companies', company.data.path as string),
    images: dressImages(`company-${company.id}`),
    linkedin_url: company.data.linkedin_url ?? null,
    titles,
    raw_titles: titles.map((t) => t.name).join(', ') || null,
    past: tm.data.past,
    is_founder: tm.data.is_founder,
    is_executive: tm.data.is_executive,
    is_partner: tm.data.is_partner,
    year_start: tm.data.year_start,
    year_end: tm.data.year_end,
  };
}

/** GUESSED: the real API has no dedicated founder→company endpoint (the
 *  digest notes this); the embedded `companies` list on the person is built
 *  here from `team_membership` rows scoped to companies. */
function personCompanies(store: EntityStore, personId: string): Record<string, unknown>[] {
  return store
    .list(SVC, 'team_membership')
    .filter((tm) => tm.data.orgType === 'company' && tm.data.personId === personId)
    .map((tm) => {
      const company = store.get(SVC, 'company', tm.data.orgId as string);
      return company ? dressUserCompany(company, tm) : null;
    })
    .filter((c): c is Record<string, unknown> => c != null);
}

function personView(store: EntityStore, row: Entity): Record<string, unknown> {
  const d = row.data;
  return {
    id: Number(row.id),
    type: 'person',
    name: d.name,
    path: d.path,
    url: profileUrl('people', d.path as string),
    images: dressImages(`person-${row.id}`),
    tagline: d.tagline,
    linkedin_url: d.linkedin_url,
    twitter_url: d.twitter_url ?? null,
    website_url: d.website_url ?? null,
    gender: d.gender,
    is_founder: d.is_founder,
    is_serial_founder: d.is_serial_founder,
    is_strong_founder: d.is_strong_founder,
    is_super_founder: d.is_super_founder,
    is_promising_founder: d.is_promising_founder,
    founder_score: d.founder_score,
    founded_companies_total_funding: d.founded_companies_total_funding,
    backgrounds: d.backgrounds,
    hq_locations: d.hq_locations,
    last_updated: d.last_updated,
    last_updated_utc: d.last_updated_utc,
    created_utc: d.created_utc,
    companies: embeddedList(personCompanies(store, row.id)),
  };
}

function personMatchesFilters(c: Record<string, unknown>, formData: FormData): boolean {
  const checks: FilterChecks = {
    gender: (v) => matchesTerms([String(c.gender ?? '')], v),
    backgrounds: (v) => matchesTerms(paramNames(c.backgrounds), v),
    locations: (v) => matchesLocationText(c.hq_locations, v),
    is_strong_founder: (v) => matchesBool(c.is_strong_founder as boolean, v),
    is_super_founder: (v) => matchesBool(c.is_super_founder as boolean, v),
    is_promising_founder: (v) => matchesBool(c.is_promising_founder as boolean, v),
    last_updated_utc: (v) => matchesDateMin(c.last_updated_utc as string, v),
    created_utc_min: (v) => matchesDateMin(c.created_utc as string, v),
    created_utc_max: (v) => matchesDateMax(c.created_utc as string, v),
  };
  return applyFormData(checks, formData);
}

// ── transaction / round ──────────────────────────────────────────────

/** Flattened search context: `full` is the dressed response payload; the
 *  rest are filter/sort inputs pulled up from the round + its company (round
 *  itself carries no name or industries of its own). */
function roundSearchCtx(store: EntityStore, row: Entity): Record<string, unknown> {
  const full = roundFullView(store, row);
  const company = (full.company ?? {}) as Record<string, unknown>;
  const investorNames = ((full.investors as Record<string, unknown>[]) ?? []).map((i) => String(i.name ?? ''));
  return {
    full,
    id: full.id,
    companyName: company.name,
    companyWebsite: company.website_url,
    industries: paramNames(company.industries),
    hq_locations: company.hq_locations,
    investorNames,
    round: full.round,
    date: row.data.date,
    amount: full.amount,
    is_verified: full.is_verified,
    last_updated_utc: full.last_updated_utc,
    created_utc: full.created_utc,
  };
}

function transactionMatchesFilters(c: Record<string, unknown>, formData: FormData): boolean {
  const checks: FilterChecks = {
    rounds: (v) => matchesTerms([String(c.round ?? '')], v),
    date_min: (v) => matchesDateMin(c.date ? `${c.date} 00:00:00` : null, v),
    date_max: (v) => matchesDateMax(c.date ? `${c.date} 23:59:59` : null, v),
    amount_min: (v) => matchesRangeMin(c.amount as number, v),
    amount_max: (v) => matchesRangeMax(c.amount as number, v),
    industries: (v) => matchesTerms(c.industries as string[], v),
    hq_locations: (v) => matchesLocationText(c.hq_locations, v),
    investors: (v) => matchesTerms(c.investorNames as string[], v),
    is_verified: (v) => matchesBool(c.is_verified as boolean, v),
    created_utc_min: (v) => matchesDateMin(c.created_utc as string, v),
    created_utc_max: (v) => matchesDateMax(c.created_utc as string, v),
  };
  return applyFormData(checks, formData);
}

// ── similar companies ──────────────────────────────────────────────────

function dressCompanySimilar(store: EntityStore, row: Entity): Record<string, unknown> {
  const full = companyView(store, row);
  return {
    id: full.id,
    type: full.type,
    name: full.name,
    path: full.path,
    url: full.url,
    images: full.images,
    tagline: full.tagline,
    website_url: full.website_url,
    linkedin_url: row.data.linkedin_url ?? null,
    hq_locations: full.hq_locations,
    growth_stage: full.growth_stage,
    employees: full.employees,
  };
}

function similarCompanies(store: EntityStore, companyId: string): Entity[] {
  const company = store.get(SVC, 'company', companyId);
  if (!company) return [];
  const myIndustries = new Set(paramNames(company.data.industries));
  return store
    .list(SVC, 'company')
    .filter((c) => c.id !== companyId && paramNames(c.data.industries).some((n) => myIndustries.has(n)));
}

// ── request log ────────────────────────────────────────────────────────

/** How many recent requests the log keeps. Enough to read one movement run's
 *  whole conversation with Dealroom, small enough to stay readable. */
const REQUEST_LOG_LIMIT = 40;

/**
 * Every call the adapter makes, in order, as its own `request_log` entity.
 *
 * WHERE and ORDER BY pushdown is a claim about what the adapter SENDS, and the
 * response alone cannot tell a pushed-down search from one the engine filtered
 * afterwards — both return the same rows. So the fake records the request
 * bodies and `pnpm dev:inspect dealroom` reads them back: `keyword`,
 * `form_data` and `sort` present on the wire IS the pushdown.
 */
function logRequest(store: EntityStore, req: import('express').Request): void {
  const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  store.create(SVC, 'request_log', {
    at: new Date().toISOString(),
    method: req.method,
    path: req.path,
    query: req.query ?? {},
    body: req.method === 'POST' ? (req.body ?? {}) : undefined,
  }, id);
  const rows = store.list(SVC, 'request_log');
  for (const stale of rows.slice(0, Math.max(0, rows.length - REQUEST_LOG_LIMIT))) {
    store.delete(SVC, 'request_log', stale.id);
  }
}

// ── router ─────────────────────────────────────────────────────────────

export function dealroomRoutes(store: EntityStore): Router {
  const r = Router();

  // Every request is HTTP Basic auth, key as username, empty password — any
  // non-empty key is accepted (the fake doesn't model per-key entitlement).
  r.use((req, res, next) => {
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Basic ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    let decoded: string;
    try {
      decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    } catch {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const [apiKey] = decoded.split(':');
    if (!apiKey) return res.status(401).json({ message: 'Unauthorized' });
    logRequest(store, req);
    next();
  });

  // ── search ─────────────────────────────────────────────────────────
  r.post('/companies', (req, res) => {
    const body = parseSearchBody(req.body);
    const lo = resolveLimitOffset(body, res);
    if (!lo) return;
    let rows = store.list(SVC, 'company').map((row) => companyView(store, row));
    rows = rows.filter((c) => matchesKeyword(c.name as string, c.website_url as string, body));
    rows = rows.filter((c) => companyMatchesFilters(c, body.form_data));
    rows = applySort(rows, body.sort, {
      name: (c) => String(c.name),
      total_funding: (c) => Number(c.total_funding),
      last_funding_date: (c) => String(c.last_funding_date ?? ''),
      last_updated_utc: (c) => String(c.last_updated_utc ?? ''),
      created_utc: (c) => String(c.created_utc ?? ''),
    });
    res.json({
      total: rows.length,
      items: rows.slice(lo.offset, lo.offset + lo.limit).map((c) => projectFields(c, body.fields)),
    });
  });

  r.post('/investors', (req, res) => {
    const body = parseSearchBody(req.body);
    const lo = resolveLimitOffset(body, res);
    if (!lo) return;
    let rows = store.list(SVC, 'investor').map((row) => investorView(store, row));
    rows = rows.filter((c) => matchesKeyword(c.name as string, c.website_url as string, body));
    rows = rows.filter((c) => investorMatchesFilters(c, body.form_data));
    rows = applySort(rows, body.sort, {
      name: (c) => String(c.name),
      total_funding: (c) => Number(c.total_funding),
      recent_funding: (c) => String(c.recent_funding ?? ''),
      last_updated_utc: (c) => String(c.last_updated_utc ?? ''),
      created_utc: (c) => String(c.created_utc ?? ''),
    });
    res.json({
      total: rows.length,
      items: rows.slice(lo.offset, lo.offset + lo.limit).map((c) => projectFields(c, body.fields)),
    });
  });

  r.post('/founders', (req, res) => {
    const body = parseSearchBody(req.body);
    const lo = resolveLimitOffset(body, res);
    if (!lo) return;
    let rows = store.list(SVC, 'person').map((row) => personView(store, row));
    rows = rows.filter((c) => matchesKeyword(c.name as string, c.website_url as string, body));
    rows = rows.filter((c) => personMatchesFilters(c, body.form_data));
    rows = applySort(rows, body.sort, {
      name: (c) => String(c.name),
      last_updated_utc: (c) => String(c.last_updated_utc ?? ''),
      created_utc: (c) => String(c.created_utc ?? ''),
    });
    res.json({
      total: rows.length,
      items: rows.slice(lo.offset, lo.offset + lo.limit).map((c) => projectFields(c, body.fields)),
    });
  });

  r.post('/transactions', (req, res) => {
    const body = parseSearchBody(req.body);
    const lo = resolveLimitOffset(body, res);
    if (!lo) return;
    let rows = store.list(SVC, 'round').map((row) => roundSearchCtx(store, row));
    rows = rows.filter((c) => matchesKeyword(c.companyName as string, c.companyWebsite as string, body));
    rows = rows.filter((c) => transactionMatchesFilters(c, body.form_data));
    rows = applySort(rows, body.sort, {
      name: (c) => String(c.companyName ?? ''),
      date: (c) => String(c.date ?? ''),
      amount: (c) => Number(c.amount ?? 0),
      last_updated_utc: (c) => String(c.last_updated_utc ?? ''),
      created_utc: (c) => String(c.created_utc ?? ''),
    });
    res.json({
      total: rows.length,
      items: rows.slice(lo.offset, lo.offset + lo.limit).map((c) => projectFields(c.full as Record<string, unknown>, body.fields)),
    });
  });

  // ── batch (before :id so "batch" never matches as an id) ────────────
  function batchHandler(entityType: string, view: (store: EntityStore, row: Entity) => Record<string, unknown>) {
    return (req: import('express').Request, res: import('express').Response) => {
      const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
      const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return res.json({ total: 0, items: [] });
      if (ids.length > 50) return res.status(400).json({ message: 'ids accepts at most 50 values' });
      const fields = typeof req.query.fields === 'string' ? req.query.fields : undefined;
      const items = ids
        .map((id) => findByIdOrPath(store, entityType, id))
        .filter((row): row is Entity => row != null)
        .map((row) => projectFields(view(store, row), fields));
      res.json({ total: items.length, items });
    };
  }
  r.get('/companies/batch', batchHandler('company', companyView));
  r.get('/investors/batch', batchHandler('investor', investorView));
  r.get('/founders/batch', batchHandler('person', personView));

  // ── get by id or path ─────────────────────────────────────────────
  function getHandler(entityType: string, view: (store: EntityStore, row: Entity) => Record<string, unknown>, notFoundTag: string) {
    return (req: import('express').Request, res: import('express').Response) => {
      const row = findByIdOrPath(store, entityType, req.params.id);
      if (!row) return res.status(404).json({ message: notFoundTag });
      const fields = typeof req.query.fields === 'string' ? req.query.fields : undefined;
      res.json(projectFields(view(store, row), fields));
    };
  }
  r.get('/companies/:id', getHandler('company', companyView, 'Company not found'));
  r.get('/investors/:id', getHandler('investor', investorView, 'Investor not found'));
  r.get('/founders/:id', getHandler('person', personView, 'Founder not found'));

  // ── company sub-resources ────────────────────────────────────────
  function pageQuery(req: import('express').Request): { limit: number; offset: number; fields?: string } {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 10;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
    const fields = typeof req.query.fields === 'string' ? req.query.fields : undefined;
    return { limit: Number.isFinite(limit) && limit > 0 ? limit : 10, offset: Number.isFinite(offset) && offset >= 0 ? offset : 0, fields };
  }

  r.get('/companies/:id/fundings', (req, res) => {
    const company = findByIdOrPath(store, 'company', req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    const { limit, offset, fields } = pageQuery(req);
    const rounds = [...companyRounds(store, company.id)].sort((a, b) => (b.data.date as string).localeCompare(a.data.date as string));
    const items = rounds.slice(offset, offset + limit).map((r) => projectFields(dressBaseFunding(store, r), fields));
    res.json({ total: rounds.length, items });
  });

  r.get('/companies/:id/investors', (req, res) => {
    const company = findByIdOrPath(store, 'company', req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    const { limit, offset, fields } = pageQuery(req);
    const rows = companyInvestorRows(store, company.id);
    const items = rows.slice(offset, offset + limit).map((ci) => projectFields(dressCompanyInvestor(store, ci), fields));
    res.json({ total: rows.length, items });
  });

  r.get('/companies/:id/team', (req, res) => {
    const company = findByIdOrPath(store, 'company', req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    const { limit, offset, fields } = pageQuery(req);
    let rows = companyTeam(store, company.id);
    const boolFilter = (key: 'is_founder' | 'is_executive' | 'is_partner') => {
      if (req.query[key] === undefined) return;
      const want = String(req.query[key]) === 'true';
      rows = rows.filter((tm) => Boolean(tm.data[key]) === want);
    };
    boolFilter('is_founder');
    boolFilter('is_executive');
    boolFilter('is_partner');
    const items = rows.slice(offset, offset + limit).map((tm) => projectFields(dressTeamMember(store, tm), fields));
    res.json({ total: rows.length, items });
  });

  r.get('/companies/:id/similar', (req, res) => {
    const company = findByIdOrPath(store, 'company', req.params.id);
    if (!company) return res.status(404).json({ message: 'Company not found' });
    const { limit, offset, fields } = pageQuery(req);
    let rows = similarCompanies(store, company.id).map((c) => ({ row: c, dressed: dressCompanySimilar(store, c) }));
    const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
    if (sort) {
      const desc = sort.startsWith('-');
      const key = desc ? sort.slice(1) : sort;
      if (key === 'name') {
        rows = [...rows].sort((a, b) => String(a.dressed.name).localeCompare(String(b.dressed.name)));
        if (desc) rows.reverse();
      }
    }
    const items = rows.slice(offset, offset + limit).map(({ dressed }) => projectFields(dressed, fields));
    res.json({ total: rows.length, items });
  });

  // ── investor sub-resources ───────────────────────────────────────
  r.get('/investors/:id/investments', (req, res) => {
    const investor = findByIdOrPath(store, 'investor', req.params.id);
    if (!investor) return res.status(404).json({ message: 'Investor not found' });
    const { limit, offset, fields } = pageQuery(req);
    const rows = investorCompanyInvestorRows(store, investor.id);
    const items = rows.slice(offset, offset + limit).map((ci) => projectFields(dressInvestorInvestment(store, ci), fields));
    res.json({ total: rows.length, items });
  });

  r.get('/investors/:id/fundings', (req, res) => {
    const investor = findByIdOrPath(store, 'investor', req.params.id);
    if (!investor) return res.status(404).json({ message: 'Investor not found' });
    const { limit, offset, fields } = pageQuery(req);
    const rounds = [...investorRounds(store, investor.id)].sort((a, b) => (b.data.date as string).localeCompare(a.data.date as string));
    const items = rounds.slice(offset, offset + limit).map((r) => projectFields(roundFullView(store, r), fields));
    res.json({ total: rounds.length, items });
  });

  r.get('/investors/:id/co_investors', (req, res) => {
    const investor = findByIdOrPath(store, 'investor', req.params.id);
    if (!investor) return res.status(404).json({ message: 'Investor not found' });
    const { limit, offset, fields } = pageQuery(req);
    const rows = coInvestorsFor(store, investor.id).map(investorShortView);
    const items = rows.slice(offset, offset + limit).map((v) => projectFields(v, fields));
    res.json({ total: rows.length, items });
  });

  r.get('/investors/:id/funds', (req, res) => {
    const investor = findByIdOrPath(store, 'investor', req.params.id);
    if (!investor) return res.status(404).json({ message: 'Investor not found' });
    const { limit, offset, fields } = pageQuery(req);
    const rows = store.list(SVC, 'fund').filter((f) => f.data.investorId === investor.id);
    const items = rows.slice(offset, offset + limit).map((f) => projectFields(dressFund(f), fields));
    res.json({ total: rows.length, items });
  });

  r.get('/investors/:id/team', (req, res) => {
    const investor = findByIdOrPath(store, 'investor', req.params.id);
    if (!investor) return res.status(404).json({ message: 'Investor not found' });
    const { limit, offset, fields } = pageQuery(req);
    const rows = investorTeam(store, investor.id);
    const items = rows.slice(offset, offset + limit).map((tm) => projectFields(dressTeamMember(store, tm), fields));
    res.json({ total: rows.length, items });
  });

  return r;
}
