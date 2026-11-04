// The listens a 0.12 text declares, read by 0.12's own parser: what production's
// browser read at 0.12.13 (`listeners-panel.tsx`, `movement/files.ts`). The
// parser is not in the browser for a carried version, so the panel asks here.

import {
  MovementParseError,
  expressionOfSlot,
  parseProgram,
  type ExprSlot,
  type ListenDeclaration,
  type Program,
} from '@listen-fire/movement-lang';

interface Listen {
  instance: string;
  configKey: string | null;
  address: string | null;
  movement: string;
  startLine: number;
  endLine: number;
}

export interface ListenOutline {
  active: (Listen & { adapter: string | null; traversal: boolean })[] | null;
  paused: Listen[];
  adapters: Record<string, string> | null;
  facets: {
    listenerCount: number;
    runnableOnDemand: boolean;
    isAutomation: boolean;
    exportedMovementCount: number;
    exportedShapeCount: number;
    isLibrary: boolean;
  };
}

function configValueString(slot: ExprSlot): string {
  try {
    const expr = expressionOfSlot(slot);
    if (expr.type === 'static' && typeof expr.value === 'string') return expr.value;
  } catch {
    // Not an expression: the raw spelling, which the server's key uses too.
  }
  return slot.raw.trim();
}

function configKeyOf(listen: ListenDeclaration): string | null {
  for (const name of ['key', 'type', 'schedule']) {
    const arg = listen.config.find((a) => a.name === name);
    if (arg !== undefined) return configValueString(arg.value);
  }
  return null;
}

function instanceAdapters(program: Program): Map<string, string> {
  const originals = new Map<string, string>();
  const adapters = new Map<string, string>();
  for (const statement of program.statements) {
    if (statement.kind === 'import') {
      for (const { name, alias } of statement.names) {
        if (alias !== undefined) originals.set(alias, name);
      }
    } else if (statement.kind === 'assign' && statement.value.kind === 'construct') {
      const { callee } = statement.value.construct;
      adapters.set(statement.name, originals.get(callee) ?? callee);
    }
  }
  return adapters;
}

function parsedOrNull(source: string, pin: string): Program | null {
  try {
    return parseProgram(source, { languageVersion: pin });
  } catch (error) {
    if (error instanceof MovementParseError) return null;
    throw error;
  }
}

const COMMENT_PREFIX = /^(\s*)#\s?/;
const COMMENTED_LISTEN_START = /^\s*#\s?listen\s/;
const MAX_LISTEN_LINES = 10;

function pausedListens(source: string, pin: string): Listen[] {
  const lines = source.split('\n');
  const paused: Listen[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!COMMENTED_LISTEN_START.test(lines[i] ?? '')) continue;
    for (let j = i; j < Math.min(i + MAX_LISTEN_LINES, lines.length); j++) {
      if (!COMMENT_PREFIX.test(lines[j] ?? '')) break;
      const snippet = lines
        .slice(i, j + 1)
        .map((line) => line.replace(COMMENT_PREFIX, '$1'))
        .join('\n');
      const statements = parsedOrNull(snippet, pin)?.statements;
      const only = statements?.length === 1 ? statements[0] : undefined;
      if (only?.kind === 'listen') {
        paused.push({
          instance: only.instance,
          configKey: configKeyOf(only),
          address: null,
          movement: only.movement,
          startLine: i + 1,
          endLine: j + 1,
        });
        i = j;
        break;
      }
    }
  }
  return paused;
}

/** The run host's `manual` unit, unless the file constructs its own. */
function isManual(listen: ListenDeclaration, adapters: ReadonlyMap<string, string>): boolean {
  const adapter = adapters.get(listen.instance);
  return (adapter ?? listen.instance).replace(/^@lf\//, '') === 'manual';
}

export function outlineOf(request: { source: string; pin: string }): ListenOutline {
  const paused = pausedListens(request.source, request.pin);
  const program = parsedOrNull(request.source, request.pin);
  if (program === null) {
    return {
      active: null,
      paused,
      adapters: null,
      facets: { listenerCount: 0, runnableOnDemand: false, isAutomation: false, exportedMovementCount: 0, exportedShapeCount: 0, isLibrary: false },
    };
  }
  const adapters = instanceAdapters(program);
  const listens = program.statements.filter((statement): statement is ListenDeclaration => statement.kind === 'listen');
  const exported = program.statements.filter((statement) => (statement.kind === 'movement' || statement.kind === 'shape') && statement.exported === true);
  const exportedMovementCount = exported.filter((statement) => statement.kind === 'movement').length;
  return {
    active: listens.map((listen) => ({
      instance: listen.instance,
      adapter: adapters.get(listen.instance) ?? null,
      configKey: configKeyOf(listen),
      // 0.12's listen names its instance: a traversal is a later spelling.
      traversal: false,
      address: null,
      movement: listen.movement,
      startLine: listen.span.start.line,
      endLine: listen.span.end.line,
    })),
    paused,
    adapters: Object.fromEntries(adapters),
    facets: {
      listenerCount: listens.length,
      runnableOnDemand: listens.some((listen) => isManual(listen, adapters)),
      isAutomation: listens.length > 0,
      exportedMovementCount,
      exportedShapeCount: exported.length - exportedMovementCount,
      isLibrary: exported.length > 0,
    },
  };
}
