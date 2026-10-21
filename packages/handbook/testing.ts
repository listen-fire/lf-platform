// For test files only: the catalog every example the handbook shows is checked
// against, and the check itself — the one a run on the Rust engine passes
// before it executes (the pin, the parse, the Rust checker). The handbook's own
// tests hold its chapters, its front page and the search's control forms to
// it; a host holds the sections it adds (`system:*`, `plugin:*`) to the same
// catalog and the same check.
//
// THE FIXTURE IS CAPTURED FROM THE REAL ADAPTERS, NOT HAND-WRITTEN.
// `__test__/adapter_schemas.fixture.json` is the live output of the real
// catalog projection for the dev-loop workspace (the procedure is in the
// platform's docs/dev-loop.md, "Regenerating the handbook's adapter schema
// snapshot"). A hand-written fixture validates an example against a shape
// someone imagined: the previous one declared `Companies -[:People]-> People`,
// an edge REAL Attio does not have, so an example could pass and still be
// untrue. Captured schemas make "passes the test" and "true about the adapter"
// the same statement.
//
// The capture is driven FROM the handbook's probes (`--handbook`), through the
// very catalog build a save performs, so what gets described is what the
// examples demand: the fixture is the union of what the examples demand, and an
// example that names something no example demands is one it cannot back.

import { CURRENT_LANGUAGE_VERSION, mockCatalogSnapshot, type AdapterSpec, type CatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { bundledPluginSpecs } from 'movement-engine/public/plugins';
import { programCheck } from 'movement-engine/public/movement-engine';

import type { Chapter, EngineClaim } from './types';

import adapterSchemas from './__test__/adapter_schemas.fixture.json';
import kgOntology from './__test__/kg_ontology.fixture.json';

/** The adapters the capture described, by type. */
export const CAPTURED_ADAPTERS: readonly string[] = Object.keys(adapterSchemas.schemas);

const capturedSchemas = adapterSchemas.schemas as Record<string, InstanceSchema>;
const capturedSpecs = adapterSchemas.specs as Record<string, Omit<AdapterSpec, 'schema'>>;

/**
 * The knowledge graph's ontology — the one schema here that is NOT captured,
 * and could not be: the graph's types ARE a team's own data model, so there is
 * no workspace-independent ontology to record. It is a REPRESENTATIVE
 * ontology (`Company`, `Person`, `Support Ticket`) over the graph's real event
 * surface; what the kg probes are held to is the language surface over it.
 * The host that ships the graph rebuilds this fixture from its own module and
 * fails when the two differ, so a rename there cannot leave the examples
 * teaching a spelling the graph no longer answers to.
 */
export const HANDBOOK_KG_SPEC = kgOntology as AdapterSpec & { schema: InstanceSchema };

/**
 * The credential names the chapters import. Chapters name credentials
 * illustratively (`acme`, `main_crm`, `team_chat`) — a workspace's connections
 * are its own — so each alias maps to the adapter whose REAL captured schema
 * backs it. The schema is what's under test; the name is set dressing.
 */
const CREDENTIAL_ADAPTERS: Record<string, string> = {
  acme: 'attio',
  acme_main: 'attio',
  main_crm: 'attio',
  acme_slack: 'slack',
  team_chat: 'slack',
  team_workspace: 'slack',
  team_telegram: 'telegram',
};

/** The snapshot a run of any example would be handed. */
export const HANDBOOK_CATALOG: CatalogSnapshot = mockCatalogSnapshot({
  adapters: {
    ...Object.fromEntries(
      CAPTURED_ADAPTERS.map((adapter) => [adapter, { ...capturedSpecs[adapter], schema: capturedSchemas[adapter] }]),
    ),
    kg: HANDBOOK_KG_SPEC,
  },
  credentials: Object.fromEntries(Object.entries(CREDENTIAL_ADAPTERS).map(([name, adapter]) => [name, { adapter }])),
  // The real registry, not a hand-kept copy: a chapter teaching an argument
  // the plugin doesn't accept fails here rather than passing against a
  // literal someone remembered to update.
  plugins: bundledPluginSpecs(),
});

/**
 * Probes deliberately NOT checked, each with the reason. A probe belongs here
 * only when the checker cannot be given a truthful catalog for it — never
 * because it fails. Keep this list short: it is the hole coverage escapes
 * through, and the tests pin its size.
 */
export const CHECK_EXEMPT: ReadonlyArray<{ match: string; why: string }> = [
  {
    match: 'file imports (shared movement libraries)',
    why: 'imports a movement from another FILE; the checker needs a file resolver, not a catalog',
  },
  {
    match: 'tuple-path multi-parent writes',
    why: 'no captured system publishes a real many-to-many JOIN record. Attio comes closest — `Notes`/`Tasks`/`files` are writable from Companies, People and Deals — but each of those children carries a single scalar `parent_object`/`parent_record_id`, so it belongs to exactly ONE record. The checker WOULD accept `write (co-[:Notes]->, p-[:Notes]->) { … }`, because the captured schema has no way to express single-parent-ness; validating it there would buy a green test for an example that is false about Attio, which is the exact failure this file exists to prevent. Revisit when a system with a genuine join type is connected.',
  },
];

export function checkExemption(claim: Pick<EngineClaim, 'construct'>): { match: string; why: string } | undefined {
  return CHECK_EXEMPT.find((e) => claim.construct.includes(e.match));
}

/** Every claim `chapters` make, each with the chapter it is made in. */
export function claimsOf(chapters: Iterable<Chapter>): Array<EngineClaim & { chapter: string }> {
  return [...chapters].flatMap((chapter) => (chapter.engineClaims ?? []).map((claim) => ({ ...claim, chapter: chapter.id })));
}

/**
 * The check a run of `claim.probe` passes before the Rust engine executes it,
 * under the release's current language version (the handbook teaches the
 * language a movement saved today is pinned to), against `HANDBOOK_CATALOG`.
 * Throws as the engine refuses: MOVENG_PARSE, or MOVENG_CHECK naming every
 * blocking diagnostic.
 */
export function admitProbe(claim: EngineClaim, catalog: CatalogSnapshot = HANDBOOK_CATALOG): void {
  const files = claim.status === 'runs' ? claim.files : undefined;
  programCheck.checkPinnedInRust({
    source: claim.probe,
    catalog: files
      ? { ...catalog, files: Object.fromEntries(Object.entries(files).map(([path, source]) => [path, { source }])) }
      : catalog,
    languageVersion: CURRENT_LANGUAGE_VERSION,
  });
}

/** Only the parse the engine performs first: MOVENG_PARSE when it refuses. */
export function parseProbe(claim: EngineClaim): void {
  programCheck.parsePinned({ source: claim.probe, languageVersion: CURRENT_LANGUAGE_VERSION });
}
