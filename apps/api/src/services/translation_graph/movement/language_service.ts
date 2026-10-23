// The editor's completion, hover and definition for a release pin: the wasm's
// language service, against the run snapshot `check` lints against, so what
// completes is what the lint accepts. A legacy pin's language service is
// legacy-lang's, in the browser; a pin the installed language does not read
// gets the binding's empty answers, and no catalog is assembled for it.

import { LRUCache } from 'lru-cache';
import {
  BridgeError,
  EMPTY_CATALOG_SNAPSHOT,
  LANGUAGE_VERSION,
  MovementParseError,
  completionsAt,
  definitionAt,
  hoverAt as hoverInWasm,
  type CatalogSnapshot,
  type Completions,
  type Definition,
  type HoverCard,
  type LanguageVersion,
} from 'movement-lang';
import { getMovementCompletions } from 'legacy-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import { movementCatalogForTeam, movementCatalogSnapshotForTeam, type TeamMovementCatalog } from './catalog';
import { routeOf } from './language_route';
import { getMovementRow } from './store';

/**
 * The pin an editor request is answered under: the movement's when `id` is
 * given, else `languageVersion`, else the installed release. Null when `id`
 * names no movement of this team.
 */
export async function editorPinOf(input: {
  teamId: string;
  id?: string;
  languageVersion?: LanguageVersion;
}): Promise<LanguageVersion | null> {
  if (input.id === undefined) return input.languageVersion ?? LANGUAGE_VERSION;
  const row = await getMovementRow({ teamId: input.teamId, id: input.id });
  return row === null ? null : row.languageVersion;
}

/**
 * `source` with the line holding `offset` emptied but for its braces: the
 * native service's own recovery (`recover::parse_recovering`), so a line being
 * typed does not stop the rest of the program from scanning. Unlike the
 * native rule, the line keeps no spaces: only the scan reads this text, never
 * an offset into it, and a blank whose width followed the line would key each
 * keystroke apart.
 */
function withCursorLineBlanked(source: string, offset: number): string {
  const start = source.lastIndexOf('\n', offset - 1) + 1;
  const newline = source.indexOf('\n', offset);
  const end = newline === -1 ? source.length : newline;
  const blanked = source.slice(start, end).replace(/[^{}\r]/g, '');
  return source.slice(0, start) + blanked + source.slice(end);
}

// Keystrokes on one line share a key, so typing a word assembles the catalog
// once. The promise is held, so requests racing on one line share one assembly.
const editorSnapshots = new LRUCache<string, Promise<CatalogSnapshot>>({ max: 100, ttl: 30_000 });

/**
 * The run snapshot for the program being edited. A source that does not scan
 * is retried with the cursor's line blanked, then falls back to a catalog
 * that describes nothing, as the lint does.
 */
function editorSnapshotOf(input: {
  teamId: string;
  source: string;
  pin: LanguageVersion;
  offset: number;
}): Promise<CatalogSnapshot> {
  const blanked = withCursorLineBlanked(input.source, input.offset);
  const key = JSON.stringify([input.teamId, input.pin, blanked]);
  const cached = editorSnapshots.get(key);
  if (cached !== undefined) return cached;
  const assembling = assembleEditorSnapshot({ ...input, blanked });
  editorSnapshots.set(key, assembling);
  assembling.catch(() => editorSnapshots.delete(key));
  return assembling;
}

async function assembleEditorSnapshot(input: {
  teamId: string;
  source: string;
  blanked: string;
  pin: LanguageVersion;
}): Promise<CatalogSnapshot> {
  const teamId = input.teamId as TeamId;
  const teamCatalog =
    (await scannedCatalog(teamId, input.source, input.pin)) ??
    (await scannedCatalog(teamId, input.blanked, input.pin)) ??
    (await movementCatalogForTeam(teamId, { types: [] }));
  if (teamCatalog.runSnapshot === undefined) throw new Error('a release pin is served against its run snapshot');
  return teamCatalog.runSnapshot();
}

/** The catalog scoped to `source`, or null when `source` does not scan. */
async function scannedCatalog(
  teamId: TeamId,
  source: string,
  pin: LanguageVersion,
): Promise<TeamMovementCatalog | null> {
  try {
    return await movementCatalogForTeam(teamId, { source, languageVersion: pin });
  } catch (e) {
    if (e instanceof BridgeError || e instanceof MovementParseError) return null;
    throw e;
  }
}

export const LEGACY_PRESENTATION_MESSAGE = "a legacy pin's language service runs in the browser";

/** What an editor request comes back as. `legacy-presentation`: the pin is a
 *  legacy id, whose language service is the browser's. */
export type EditorAnswer<T> =
  | { kind: 'answer'; answer: T }
  | { kind: 'not-found' }
  | { kind: 'legacy-presentation'; pin: LanguageVersion };

interface EditorRequest {
  teamId: string;
  source: string;
  /** A UTF-16 offset into `source`. */
  offset: number;
  id?: string;
  languageVersion?: LanguageVersion;
}

type Ask<T> = (source: string, offset: number, snapshot: CatalogSnapshot, options: { languageVersion: LanguageVersion }) => T;

async function answerAt<T>(request: EditorRequest, ask: Ask<T>): Promise<EditorAnswer<T>> {
  const pin = await editorPinOf(request);
  if (pin === null) return { kind: 'not-found' };
  const route = routeOf(pin);
  switch (route.kind) {
    case 'legacy':
      return { kind: 'legacy-presentation', pin };
    case 'refused':
      // The binding's own empty answer: it never asks the artifact for a pin
      // this release does not read, so the empty snapshot is never read.
      return { kind: 'answer', answer: ask(request.source, request.offset, EMPTY_CATALOG_SNAPSHOT, { languageVersion: pin }) };
    case 'installed': {
      const snapshot = await editorSnapshotOf({ teamId: request.teamId, source: request.source, pin, offset: request.offset });
      return { kind: 'answer', answer: ask(request.source, request.offset, snapshot, { languageVersion: pin }) };
    }
    default: {
      const unreachable: never = route;
      throw new Error(`unhandled pin route ${JSON.stringify(unreachable)}`);
    }
  }
}

export function completeAt(request: EditorRequest): Promise<EditorAnswer<Completions>> {
  return answerAt(request, completionsAt);
}

export function hoverAt(request: EditorRequest): Promise<EditorAnswer<HoverCard | null>> {
  return answerAt(request, hoverInWasm);
}

export function defineAt(request: EditorRequest): Promise<EditorAnswer<Definition | null>> {
  return answerAt(request, definitionAt);
}

interface AgentCompletions {
  completions: Array<{ label: string; kind: string; detail?: string }>;
  note?: string;
}

/**
 * The agent's completions at `offset` under `pin`. A release pin's are the
 * wasm's against the run snapshot; a legacy id's are legacy-lang's against the
 * skeleton; a pin nothing reads gets a note instead.
 */
export async function agentCompletionsAt(input: {
  teamId: string;
  source: string;
  offset: number;
  pin: LanguageVersion;
}): Promise<AgentCompletions> {
  const route = routeOf(input.pin);
  switch (route.kind) {
    case 'installed': {
      const snapshot = await editorSnapshotOf(input);
      const { items } = completionsAt(input.source, input.offset, snapshot, { languageVersion: input.pin });
      return { completions: items.map(itemOf) };
    }
    case 'legacy': {
      const { snapshot } = await movementCatalogSnapshotForTeam(input.teamId as TeamId);
      const { items } = getMovementCompletions(input.source, input.offset, snapshot, { languageVersion: input.pin });
      return { completions: items.map(itemOf) };
    }
    case 'refused':
      return {
        completions: [],
        note: `No completions for language version ${input.pin}: this platform's language service does not read it.`,
      };
    default: {
      const unreachable: never = route;
      throw new Error(`unhandled pin route ${JSON.stringify(unreachable)}`);
    }
  }
}

function itemOf(item: { label: string; kind: string; detail?: string }): AgentCompletions['completions'][number] {
  return { label: item.label, kind: item.kind, ...(item.detail !== undefined ? { detail: item.detail } : {}) };
}
