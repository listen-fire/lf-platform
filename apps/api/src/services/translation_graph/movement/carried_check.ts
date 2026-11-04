// A pin a carried version checks (`routeOf` → `carried`): its check, its
// editor's answers and its story's verdict come from that version's own
// checker, through its package (`@listen-fire/language-versions`). The
// platform hands it what it knows of the team as plain data and takes plain
// data back; nothing of this release's catalog, checker or parser reads the
// program.

import { LRUCache } from 'lru-cache';

import type { CheckingLane, TeamFacts } from '@listen-fire/language-versions';
import type { Diagnostic, LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TeamMovementValidation } from './authoring';

import { connectMethodForType } from '../../credentials/connect_link';
import { mutationDelivery } from '../../knowledge/mutation_outbox/delivery_mode';
import { isCredentialType } from '../adapters/credential_type';
import { MCP_CONNECTIONS_ENABLED } from '../adapters/mcp/enabled';
import { WHATSAPP_MOVEMENTS_NUMBER } from '../adapters/whatsapp/shared_app';
import { dedupeDiagnostics, toAuthoringDiagnostic } from './authoring_diagnostic';
import { loadCredentialRows } from './catalog';
import { listMovementRows } from './store';

/** What the platform knows of the team, read now. */
export async function teamFactsOf(teamId: string): Promise<TeamFacts> {
  const [credentials, rows] = await Promise.all([loadCredentialRows(teamId as TeamId), listMovementRows(teamId)]);
  return {
    credentials,
    files: rows.map((row) => ({ name: row.name, source: row.source, languageVersion: row.languageVersion })),
    connectOf: (type) => (isCredentialType(type) ? connectMethodForType(type) : 'app-only'),
    kgChangeWebhooks: mutationDelivery() === 'webhook',
    mcpEnabled: MCP_CONNECTIONS_ENABLED,
    whatsappNumber: WHATSAPP_MOVEMENTS_NUMBER,
  };
}

/** A reader of team facts that reads each team once for its own life: a
 *  deploy sweep validates every automation of a team against one read of the
 *  team, not one read per automation. A failed read is not kept. */
export function teamFactsOncePerTeam(): (teamId: string) => Promise<TeamFacts> {
  const read = new Map<string, Promise<TeamFacts>>();
  return (teamId) => {
    const cached = read.get(teamId);
    if (cached !== undefined) return cached;
    const reading = teamFactsOf(teamId);
    read.set(teamId, reading);
    reading.catch(() => read.delete(teamId));
    return reading;
  };
}

// Keystrokes share the team's facts for a few seconds, as the current
// version's editor shares its snapshot: typing a word reads the team once.
const editorFacts = new LRUCache<string, Promise<TeamFacts>>({ max: 100, ttl: 30_000 });

/** The team's facts for an editor request. */
export function editorTeamFactsOf(teamId: string): Promise<TeamFacts> {
  const cached = editorFacts.get(teamId);
  if (cached !== undefined) return cached;
  const reading = teamFactsOf(teamId);
  editorFacts.set(teamId, reading);
  reading.catch(() => editorFacts.delete(teamId));
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
}): Promise<TeamMovementValidation> {
  const [lane, team] = await Promise.all([input.lane(), input.team ?? teamFactsOf(input.teamId)]);
  const checked = await lane.checkSource({ source: input.source, pin: input.pin, team });
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

/** What a pin a carried version checks but this platform does not run is
 *  told when it would go live: it is saved and checked under its own version,
 *  and its listens are not run. */
export function notRunDiagnostic(pin: LanguageVersion, current: LanguageVersion): Diagnostic {
  return {
    code: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
    message:
      `this automation is pinned to language version ${pin}: it is saved and checked under ${pin}, ` +
      `but this platform does not run ${pin}'s listens, so it does not fire until it is upgraded to ${current}`,
    span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
  };
}
