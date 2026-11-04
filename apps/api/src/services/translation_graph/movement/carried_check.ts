// A pin a carried version checks (`routeOf` → `carried`): its check, its
// editor's answers and its story's verdict come from that version's own
// checker, through its package (`@listen-fire/language-versions`). The
// platform hands it what it knows of the team as plain data and takes plain
// data back; nothing of this release's catalog, checker or parser reads the
// program.

import { LRUCache } from 'lru-cache';

import type { CheckedDiagnostic, CheckingLane, TeamFacts } from '@listen-fire/language-versions';
import type { Diagnostic, LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AuthoringDiagnostic, TeamMovementValidation } from './authoring';

import { connectMethodForType } from '../../credentials/connect_link';
import { mutationDelivery } from '../../knowledge/mutation_outbox/delivery_mode';
import { isCredentialType } from '../adapters/credential_type';
import { MCP_CONNECTIONS_ENABLED } from '../adapters/mcp/enabled';
import { WHATSAPP_MOVEMENTS_NUMBER } from '../adapters/whatsapp/shared_app';
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

/** A carried checker's diagnostic in the authoring shape, against the source
 *  it was produced from. Its severity is its own release's. */
export function authoringDiagnosticOf(diagnostic: CheckedDiagnostic, lines: readonly string[]): AuthoringDiagnostic {
  const { span } = diagnostic;
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    line: span.start.line,
    col: span.start.col,
    endLine: span.end.line,
    endCol: span.end.col,
    sourceLine: lines[span.start.line - 1] ?? '',
    ...(diagnostic.upgrade === true ? { upgrade: true as const } : {}),
    ...(diagnostic.fix !== undefined
      ? {
          fix: {
            edits: diagnostic.fix.edits.map((edit) => ({
              line: edit.span.start.line,
              col: edit.span.start.col,
              endLine: edit.span.end.line,
              endCol: edit.span.end.col,
              text: edit.text,
            })),
            ...(diagnostic.fix.safe === true ? { safe: true as const } : {}),
          },
        }
      : {}),
  };
}

/** A carried checker's diagnostic as the current release's plain diagnostic
 *  data, for a surface that takes that shape (the story's problems, a
 *  provisioning refusal). Its severity is carried with it, never re-derived
 *  by this release's rule. */
export function plainDiagnosticOf(diagnostic: CheckedDiagnostic): Diagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    span: diagnostic.span,
    severity: diagnostic.severity,
    ...(diagnostic.upgrade === true ? { upgrade: true as const } : {}),
  };
}

function dedupe(diagnostics: readonly CheckedDiagnostic[]): CheckedDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.code}@${d.span.start.line}:${d.span.start.col}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `source` validated under `pin` by its carried version's own checker,
 *  against the team. */
export async function validateUnderCarried(input: {
  teamId: string;
  source: string;
  pin: LanguageVersion;
  lane: () => Promise<CheckingLane>;
  team?: TeamFacts;
}): Promise<TeamMovementValidation> {
  const [lane, team] = await Promise.all([input.lane(), input.team ?? teamFactsOf(input.teamId)]);
  const checked = await lane.checkSource({ source: input.source, pin: input.pin, team });
  const lines = input.source.split('\n');
  const diagnostics = dedupe(checked.diagnostics).map((d) => authoringDiagnosticOf(d, lines));
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
