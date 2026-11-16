// A pin a carried version checks (`routeOf` → `carried`): its check, its
// editor's answers and its story's verdict come from that version's own
// checker, through its package (`@listen-fire/language-versions`). The
// platform hands it what it knows of the team as plain data and takes plain
// data back; nothing of this release's catalog, checker or parser reads the
// program.

import { LRUCache } from 'lru-cache';

import type { CheckingLane, DeploymentFacts, TeamFacts } from '@listen-fire/language-versions';
import type { Diagnostic, LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TeamMovementValidation } from './authoring';

import { refusalOf } from '@listen-fire/language-versions';
import { connectMethodForType } from '../../credentials/connect_link';
import { mutationDelivery } from '../../knowledge/mutation_outbox/delivery_mode';
import { isCredentialType } from '../adapters/credential_type';
import { MCP_CONNECTIONS_ENABLED } from '../adapters/mcp/enabled';
import { WHATSAPP_MOVEMENTS_NUMBER } from '../adapters/whatsapp/shared_app';
import { dedupeDiagnostics, toAuthoringDiagnostic } from './authoring_diagnostic';
import { loadCredentialRows } from './catalog';
import { audienceKey, type CatalogAudience } from './audience';
import { listMovementRows } from './store';
import { listRemoteAdapters } from '../adapters/remote/store';
import { listShippedFiles } from './version_store';
import { neverAsAny } from 'movement-engine/public/types';

/** What of the deployment decides the systems a carried version documents. */
export function deploymentFacts(): DeploymentFacts {
  return {
    kgChangeWebhooks: mutationDelivery() === 'webhook',
    mcpEnabled: MCP_CONNECTIONS_ENABLED,
    whatsappNumber: WHATSAPP_MOVEMENTS_NUMBER,
  };
}

/** What the platform knows of the team, read now. Its files are their live
 *  text (what an edit checks and a test run imports), or their shipped text
 *  (what a firing imports: a file that never shipped is not there). Its
 *  connections are the ones `audience` may see. */
export async function teamFactsOf(
  teamId: string,
  options: { imports?: 'live' | 'shipped'; audience: CatalogAudience },
): Promise<TeamFacts> {
  const [credentials, files, remotes] = await Promise.all([
    loadCredentialRows(teamId as TeamId, options.audience),
    teamFilesOf(teamId, options.imports ?? 'live'),
    listRemoteAdapters({ teamId: teamId as TeamId }),
  ]);
  return {
    credentials,
    files,
    remoteAdapters: remotes.map((row) => ({ adapterType: row.adapter_type, manifest: row.manifest })),
    connectOf: (type) => (isCredentialType(type) ? connectMethodForType(type) : 'app-only'),
    ...deploymentFacts(),
  };
}

async function teamFilesOf(teamId: string, imports: 'live' | 'shipped'): Promise<TeamFacts['files']> {
  switch (imports) {
    case 'live':
      return (await listMovementRows(teamId)).map((row) => ({ name: row.name, source: row.source, languageVersion: row.languageVersion }));
    case 'shipped':
      return listShippedFiles(teamId);
    default:
      return neverAsAny(imports);
  }
}

/** A reader of team facts that reads each team once for its own life: a
 *  deploy sweep validates every automation of a team against one read of the
 *  team, not one read per automation. A failed read is not kept. */
export function teamFactsOncePerTeam(): (teamId: string) => Promise<TeamFacts> {
  const read = new Map<string, Promise<TeamFacts>>();
  return (teamId) => {
    const cached = read.get(teamId);
    if (cached !== undefined) return cached;
    const reading = teamFactsOf(teamId, { audience: { for: 'run' } });
    read.set(teamId, reading);
    reading.catch(() => read.delete(teamId));
    return reading;
  };
}

// Keystrokes share the team's facts for a few seconds, as the current
// version's editor shares its snapshot: typing a word reads the team once.
const editorFacts = new LRUCache<string, Promise<TeamFacts>>({ max: 100, ttl: 30_000 });

/** The team's facts for an editor request, as the editing caller may see them. */
export function editorTeamFactsOf(teamId: string, audience: CatalogAudience): Promise<TeamFacts> {
  const key = JSON.stringify([teamId, audienceKey(audience)]);
  const cached = editorFacts.get(key);
  if (cached !== undefined) return cached;
  const reading = teamFactsOf(teamId, { audience });
  editorFacts.set(key, reading);
  reading.catch(() => editorFacts.delete(key));
  return reading;
}

/** `source` validated under `pin` by its carried version's own checker,
 *  against the team. */
export async function validateUnderCarried(input: {
  teamId: string;
  source: string;
  pin: LanguageVersion;
  lane: () => Promise<CheckingLane>;
  team?: Promise<TeamFacts>;
  audience: CatalogAudience;
}): Promise<TeamMovementValidation> {
  const [lane, team] = await Promise.all([input.lane(), input.team ?? teamFactsOf(input.teamId, { audience: input.audience })]);
  // Connected systems are read through the platform's hosting of the
  // version's own modules.
  const { modulePlatform } = await import('./carried_run');
  const checked = await lane.checkSource({
    source: input.source,
    pin: input.pin,
    team,
    connected: { teamId: input.teamId, modules: modulePlatform() },
  });
  const lines = input.source.split('\n');
  // A carried diagnostic carries its own release's severity, which the
  // authoring shape keeps.
  const diagnostics = dedupeDiagnostics(checked.diagnostics).map((d) => toAuthoringDiagnostic(d, lines));
  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
    listenerCount: checked.firedMovements.length,
    firedMovements: checked.firedMovements,
    catalogNotes: checked.notes,
    gaps: checked.gaps,
  };
}

/** What a save of a pin whose version does not fire its listens is told
 *  where it would go live: it is saved and checked under its own version, and
 *  what its version provides, in the registry's words. */
export function notListenedDiagnostic(pin: LanguageVersion): Diagnostic {
  const refusal = refusalOf(pin, 'listen') ?? `this release does not yet plan the listens of a ${pin} save, so the listens it shipped before keep firing as they were`;
  return {
    code: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
    message: `it is saved and checked under ${pin}; ${refusal}`,
    span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
  };
}
