// A 0.12 program checked, and asked about, by 0.12's own checker and language
// service, against the catalog 0.12's own modules describe.

import { checkSource, completionsAt } from '..';
import type { TeamFacts, TeamFile } from '../lane/types';

function team(files: TeamFile[] = []): TeamFacts {
  return {
    credentials: [{ id: 'c1', name: 'acme_main', type: 'ATTIO' }],
    files,
    connectOf: () => 'oauth',
    kgChangeWebhooks: false,
    mcpEnabled: false,
    whatsappNumber: null,
  };
}

/** A manual listen as 0.12 spells it: the unit by name, no traversal. */
const ECHO_012 = 'function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual fire echo\n';
/** The same listen as 0.13 and later spell it. */
const ECHO_015 = 'function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual-[:Invocations]-> fire echo\n';

const check = (source: string, files: TeamFile[] = []) => checkSource({ source, pin: '0.12.13', team: team(files) });

describe("a 0.12 program, by 0.12's checker", () => {
  it('reads 0.12 syntax clean, every listen counted', async () => {
    const checked = await check(ECHO_012);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.firedMovements).toEqual(['echo']);
    expect(checked.gaps).toEqual([]);
  });

  it('reports a construct only 0.13 and later read', async () => {
    const checked = await check(ECHO_015);
    expect(checked.diagnostics).toEqual([
      expect.objectContaining({ code: 'MOV_PARSE', severity: 'error', message: expect.stringContaining("Expected 'fire' after 'listen to manual'") }),
    ]);
  });

  it("checks a unit's fields against the unit as 0.12 described it", async () => {
    const checked = await check(ECHO_012.replace('run.Text', 'run.Textt'));
    expect(checked.diagnostics).toEqual([
      expect.objectContaining({ code: 'MOV_UNKNOWN_PROPERTY', severity: 'error', message: expect.stringContaining("no field 'Textt'") }),
    ]);
  });

  it('a connected system it cannot read is a gap naming it, never a clean pass', async () => {
    const source =
      'import { attio } from adapters\nimport { acme_main } from credentials\ncrm = connect attio using acme_main\n' +
      'function f(go: <manual-[:Invocation]->>) {\n  write crm-[:Companies]-> {\n    unique by (Name)\n    Name: go.Text\n  }\n}\nlisten to manual fire f\n';
    const checked = await check(source);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(checked.gaps).toEqual([{ adapter: 'attio', detail: expect.stringContaining('nothing this automation reads from or writes to attio was checked') }]);
  });
});

describe('a library import across versions', () => {
  const LIBRARY = 'export function shout(t: <text>) {\n  return t\n}\n';
  const IMPORTER = 'import { shout } from "lib"\nfunction echo(run: <manual-[:Invocation]->>) {\n  return shout(run.Text)\n}\nlisten to manual fire echo\n';

  it('a library on 0.12 resolves', async () => {
    const checked = await check(IMPORTER, [{ name: 'lib', source: LIBRARY, languageVersion: '0.12.4' }]);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('a library on another version is an error on the import, naming both pins', async () => {
    const checked = await check(IMPORTER, [{ name: 'lib', source: LIBRARY, languageVersion: '0.15.1' }]);
    const across = checked.diagnostics.find((d) => d.code === 'MOV_IMPORT_LANGUAGE_VERSION');
    expect(across).toMatchObject({ severity: 'error', span: { start: { line: 1 } } });
    expect(across?.message).toContain('0.12.13');
    expect(across?.message).toContain("'lib'");
    expect(across?.message).toContain('0.15.1');
  });

  it('a library reached through another names the way it was reached', async () => {
    const checked = await check(IMPORTER, [
      { name: 'lib', source: 'import { inner } from "deep"\n' + LIBRARY, languageVersion: '0.12.4' },
      { name: 'deep', source: 'export function inner(t: <text>) {\n  return t\n}\n', languageVersion: '0.15.1' },
    ]);
    const across = checked.diagnostics.find((d) => d.code === 'MOV_IMPORT_LANGUAGE_VERSION');
    expect(across?.message).toContain("'deep' it imports (through 'lib') is on language 0.15.1");
  });
});

describe("the editor, by 0.12's language service", () => {
  it("completes a unit's fields as 0.12 described them", async () => {
    const offset = ECHO_012.indexOf('run.Text') + 'run.'.length;
    const { items } = await completionsAt({ source: ECHO_012, offset, pin: '0.12.13', team: team() });
    expect(items.map((item) => item.label)).toEqual(['Fired at', 'Run by (email)', 'Run by (name)', 'Text', 'Content']);
  });
});
