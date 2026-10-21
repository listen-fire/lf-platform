// Credential → movement dependency scan.
//
// A movement depends on a credential when its source carries
// `import { <name> } from credentials` for one of the credential's
// import names (the names `credentialImportNames` projects from the row
// name — usually one, several when one credential type serves multiple
// adapters). There is no stored edge: like file-import dependents
// (movement/files.ts), the set is re-derived from the canonical TEXT so
// it can never drift.
//
// Detection mirrors `referencedConstructions`' lenient posture: a cheap
// parse walking every statement for builtin credential imports, with a
// line-level lexical fallback for mid-edit sources that don't parse.
// Import statements are the right signal (not constructions): a program
// can't construct an instance without importing the credential, and a
// dangling import alone already breaks the movement's next save/run.

import { type Program, type Statement } from 'movement-lang';
import { MovementParseError } from 'movement-lang';
import { parseProgram } from 'legacy-lang';

/**
 * The de-duplicated ORIGINAL credential import names the source pulls in
 * (`import { acme_main as crm } from credentials` yields `acme_main`).
 * Never throws: a program that doesn't parse falls back to a line scan.
 */
export function referencedCredentialImports(source: string): string[] {
  let names: string[];
  try {
    names = credentialImportsOfProgram(parseProgram(source));
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    names = credentialImportsByLexicalScan(source);
  }
  return [...new Set(names)];
}

function credentialImportsOfProgram(program: Program): string[] {
  const names: string[] = [];
  const walk = (statements: Statement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'import':
          if (statement.source.kind === 'builtin' && statement.source.namespace === 'credentials') {
            for (const imported of statement.names) names.push(imported.name);
          }
          break;
        case 'movement':
          walk(statement.body);
          break;
        case 'block':
          walk(statement.block.body);
          break;
        case 'if':
          for (const arm of statement.arms) walk(arm.body);
          if (statement.elseArm) walk(statement.elseArm.body);
          break;
        case 'assign':
          if (statement.value.kind === 'block') walk(statement.value.block.body);
          break;
        default:
          break;
      }
    }
  };
  walk(program.statements);
  return names;
}

const CREDENTIALS_IMPORT_LINE = /^\s*import\s*\{([^}]*)\}\s*from\s+credentials\b/;
const IMPORT_ENTRY = /^\s*([A-Za-z_]\w*)(?:\s+as\s+[A-Za-z_]\w*)?\s*$/;

function credentialImportsByLexicalScan(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const match = CREDENTIALS_IMPORT_LINE.exec(line);
    if (!match) continue;
    for (const entry of match[1].split(',')) {
      const parsed = IMPORT_ENTRY.exec(entry);
      if (parsed) names.push(parsed[1]);
    }
  }
  return names;
}

export interface CredentialDependentMovement {
  id: string;
  name: string;
  /** Runtime validity of the movement's current source (null = never checked). */
  validityStatus: string | null;
}

/**
 * Pure core: which of `rows` import any of `importNames` from
 * credentials. The caller supplies the credential's import names from
 * `credentialImportNames` (computed over ALL team credential rows, since
 * collision suffixes depend on the whole set).
 */
export function movementsImportingCredential(
  rows: Array<{ id: string; name: string; validityStatus: string | null; source: string }>,
  importNames: string[],
): CredentialDependentMovement[] {
  if (importNames.length === 0) return [];
  const wanted = new Set(importNames);
  return rows
    .filter((row) => referencedCredentialImports(row.source).some((name) => wanted.has(name)))
    .map((row) => ({ id: row.id, name: row.name, validityStatus: row.validityStatus }));
}
