// A 0.12 program checked, and asked about, by 0.12's own checker and language
// service, against the catalog 0.12's own modules describe.

import { checkSource, completionsAt } from '..';
import * as constructions from '../lane/constructions';
import type { TeamFacts, TeamFile } from '../lane/types';
import type { ModulePlatform } from '../lane/run_types';

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
    expect(checked.gaps).toEqual([{ adapter: 'attio', detail: expect.stringContaining('reads from or writes to attio was checked') }]);
  });
});

describe('a connection made anywhere is a gap', () => {
  const PRELUDE = 'import { attio } from adapters\nimport { acme_main } from credentials\n';
  const WRITE = '  write crm-[:Companies]-> {\n    unique by (Name)\n    Nme: go.Text\n  }\n';
  const ATTIO_GAP = [{ adapter: 'attio', detail: expect.stringContaining('reads from or writes to attio was checked') }];

  it('inside a function body', async () => {
    const source = `${PRELUDE}function f(go: <manual-[:Invocation]->>) {\n  crm = connect attio using acme_main\n${WRITE}}\nlisten to manual fire f\n`;
    const checked = await check(source);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(checked.gaps).toEqual(ATTIO_GAP);
  });

  it('inside a nested block, and a call to a movement is no connection', async () => {
    const source =
      `${PRELUDE}function g(go: <manual-[:Invocation]->>) {\n  return go.Text\n}\n` +
      `function f(go: <manual-[:Invocation]->>) {\n  t = g(go: go)\n  if (go.Text == "x") {\n    crm = connect attio using acme_main\n  ${WRITE}  }\n}\nlisten to manual fire f\n`;
    const checked = await check(source);
    expect(checked.gaps).toEqual(ATTIO_GAP);
  });

  it('inside a library the program imports', async () => {
    const library = `${PRELUDE}export function store(go: <manual-[:Invocation]->>) {\n  crm = connect attio using acme_main\n${WRITE}}\n`;
    const source = 'import { store } from "crm_lib"\nfunction f(go: <manual-[:Invocation]->>) {\n  store(go)\n}\nlisten to manual fire f\n';
    const checked = await check(source, [{ name: 'crm_lib', source: library, languageVersion: '0.12.4' }]);
    expect(checked.diagnostics.filter((d) => d.code === 'MOV_IMPORT_LANGUAGE_VERSION')).toEqual([]);
    expect(checked.gaps).toEqual(ATTIO_GAP);
  });
});

describe('the static surfaces 0.12 described', () => {
  it("a cron tick's fields and a cron listen's config", async () => {
    const source =
      'import { `@lf/cron` as cron } from adapters\ntimer = connect cron\nfunction d(t: <timer-[:Tick]->>) {\n  return t.`Fired att`\n}\n' +
      'listen to timer { schedule: "0 9 * * 1", scheduel: "x" } fire d\n';
    const checked = await check(source);
    expect(checked.diagnostics.map((d) => d.code)).toEqual(['MOV_UNKNOWN_PROPERTY', 'MOV_LISTEN_BAD_CONFIG']);
    expect(checked.gaps).toEqual([]);
  });

  it("a system event's fields", async () => {
    const source =
      'import { `@lf/system` as system } from adapters\nsys = connect system\nfunction r(failed: <sys-[:`Run Failed`]->>) {\n  return failed.Reasonn\n}\n' +
      'listen to sys { events: ["Run Failed"] } fire r\n';
    const checked = await check(source);
    expect(checked.diagnostics).toEqual([expect.objectContaining({ code: 'MOV_UNKNOWN_PROPERTY', message: expect.stringContaining("no field 'Reasonn'") })]);
    expect(checked.gaps).toEqual([]);
  });
});

// An ask's answer is typed by the ask's own literals, as production typed it:
// each right and each wrong use, under 0.12's own checker.
describe("an ask's answer, typed by its own literals", () => {
  const ASK = 'import { `@lf/ask` as ask } from adapters\nqa = connect ask\n';
  const asked = (body: string) => `${ASK}function m(go: <manual-[:Invocation]->>) {\n${body}}\nlisten to manual fire m\n`;
  const errorsOf = async (body: string) => {
    const checked = await check(asked(body));
    expect(checked.gaps).toEqual([]);
    return checked.diagnostics.filter((d) => d.severity === 'error');
  };

  it.each([
    [
      'a number Provide compared and added to',
      '  p = write qa-[:Provide]-> { Prompt: "How much?", `Answer Type`: "number" }\n  a = await first(p-[:Response]->)\n  return coalesce(a.Answer, 0) + 1\n',
    ],
    [
      "a Form's own fields read",
      '  q = write qa-[:Form]-> { Prompt: "Deal?", Fields: ["Budget", "Timeline"] }\n  a = await first(q-[:Response]->)\n  return a.Budget\n',
    ],
    [
      'a Choose compared with an option it offers',
      '  c = write qa-[:Choose]-> { Prompt: "Which?", Options: ["Seed", "Series A"] }\n  a = await first(c-[:Response]->)\n  if (a.Answer == "Seed") { return 1 }\n  return 0\n',
    ],
  ])('reads clean: %s', async (_, body) => {
    expect(await errorsOf(body)).toEqual([]);
  });

  it.each([
    [
      'a field the Form does not declare',
      '  q = write qa-[:Form]-> { Prompt: "Deal?", Fields: ["Budget", "Timeline"] }\n  a = await first(q-[:Response]->)\n  return a.Budgett\n',
      "no field 'Budgett'",
    ],
    [
      'a field of no ask',
      '  c = write qa-[:Check]-> { Prompt: "Sure?" }\n  a = await first(c-[:Response]->)\n  return a.Nope\n',
      "no field 'Nope'",
    ],
  ])('refuses: %s', async (_, body, message) => {
    expect(await errorsOf(body)).toEqual([expect.objectContaining({ code: 'MOV_UNKNOWN_PROPERTY', message: expect.stringContaining(message) })]);
  });

  it('a Provide answer is the type it declared: a number is arithmetic, a text is not', async () => {
    const body = (type: string) => `  p = write qa-[:Provide]-> { Prompt: "How much?", \`Answer Type\`: "${type}" }\n  a = await first(p-[:Response]->)\n  if (a.Answer != null) { return a.Answer * 2 }\n  return 0\n`;

    expect(await errorsOf(body('number'))).toEqual([]);
    expect((await errorsOf(body('text'))).length).toBeGreaterThan(0);
  });

  it('a Choose answer compared with an option it never offers is an error', async () => {
    const errors = await errorsOf('  c = write qa-[:Choose]-> { Prompt: "Which?", Options: ["Seed", "Series A"] }\n  a = await first(c-[:Response]->)\n  if (a.Answer == "Series B") { return 1 }\n  return 0\n');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('options or fields that are not literals leave the answer its base type, as production kept it', async () => {
    // Computed at run time, so nothing is known to narrow the answer to.
    expect(await errorsOf('  opts = ["Seed", "Series A"]\n  c = write qa-[:Choose]-> { Prompt: "Which?", Options: opts }\n  a = await first(c-[:Response]->)\n  if (a.Answer == "Series B") { return 1 }\n  return 0\n')).toEqual([]);
    expect(await errorsOf('  names = ["Budget"]\n  q = write qa-[:Form]-> { Prompt: "Deal?", Fields: names }\n  a = await first(q-[:Response]->)\n  return a.Budget\n')).toEqual([
      expect.objectContaining({ code: 'MOV_UNKNOWN_PROPERTY', message: expect.stringContaining("Form Response has no field 'Budget'") }),
    ]);
  });

  it('the same options in another order are another type: each ask is held to its own', async () => {
    const errors = await errorsOf(
      '  c = write qa-[:Choose]-> { Prompt: "Which?", Options: ["Seed", "Series A"] }\n  d = write qa-[:Choose]-> { Prompt: "Which?", Options: ["Series A", "Seed"] }\n' +
        '  a = await first(c-[:Response]->)\n  b = await first(d-[:Response]->)\n  if (a.Answer == "Series B") { return 1 }\n  if (b.Answer == "Series C") { return 1 }\n  return 0\n',
    );
    expect(errors.map((d) => d.message)).toEqual([
      expect.stringContaining('isn\'t a value of enum (Seed | Series A)'),
      expect.stringContaining('isn\'t a value of enum (Series A | Seed)'),
    ]);
  });

  it('each program is scanned for its writes once, not once per adapter the catalog describes', async () => {
    const scan = jest.spyOn(constructions, 'scanInstanceChains');
    try {
      await errorsOf('  c = write qa-[:Check]-> { Prompt: "Sure?" }\n  return 1\n');
      expect(scan).toHaveBeenCalledTimes(1);
    } finally {
      scan.mockRestore();
    }
  });

  it('a library that decides its own ask is typed under the importer', async () => {
    const library = `${ASK}export function deal(go: <text>) {\n  q = write qa-[:Form]-> { Prompt: "Deal?", Fields: ["Budget"] }\n  a = await first(q-[:Response]->)\n  return a.Budget\n}\n`;
    const importer = 'import { deal } from "lib"\nfunction m(go: <manual-[:Invocation]->>) {\n  return deal(go.Text)\n}\nlisten to manual fire m\n';
    const checked = await check(importer, [{ name: 'lib', source: library, languageVersion: '0.12.4' }]);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
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

  it('a library on a legacy id is on 0.12, so it resolves', async () => {
    const checked = await check(IMPORTER, [{ name: 'lib', source: LIBRARY, languageVersion: '4' }]);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
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

describe("a connected system, read through the platform's hosting of 0.12's module for it", () => {
  // A fake Affinity: every request answers an empty list, which 0.12's
  // Affinity module reads as a workspace with no lists. Its fixed entities
  // are typed from the module itself.
  let server: import('node:http').Server;
  let baseUrl = '';
  beforeAll(async () => {
    const http = await import('node:http');
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const refused = async (): Promise<never> => {
    throw new Error('not part of this test');
  };
  const modules = (): ModulePlatform => ({
    hostFor: () => ({
      credential: { name: 'api_key', fields: async () => ({ apiKey: 'k', baseUrl }), update: async () => {} },
      kv: { get: refused, set: refused, delete: refused, list: refused, compareAndSet: refused },
      files: { put: refused, read: refused, expose: refused },
    }),
    parts: {
      askAnswerUrl: () => '',
      kgStore: () => {
        throw new Error('no kg');
      },
      kgChangeWebhooks: false,
      slackChat: refused,
      readFile: refused,
      whatsappNumber: null,
      isExposedFileUrl: () => false,
      remoteInstall: refused,
      readDocument: refused,
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    validateResults: false,
  });
  const affinityTeam: TeamFacts = { ...team(), credentials: [{ id: 'cred-affinity', name: 'Acme Affinity', type: 'AFFINITY' }] };
  const program = (field: string) =>
    'import { affinity } from adapters\nimport { `Acme Affinity` } from credentials\n\ncrm = connect affinity using `Acme Affinity`\n\n' +
    `function sync(run: <manual-[:Invocation]->>) {\n  write crm-[:Organization]-> {\n    ${field}: run.Text\n  }\n}\n\nlisten to manual fire sync\n`;
  const checkConnected = (source: string) =>
    checkSource({ source, pin: '0.12.13', team: affinityTeam, connected: { teamId: 'team-1', modules: modules() } });

  it('types the instance: a clean write checks clean, with no gap', async () => {
    const checked = await checkConnected(program('Name'));
    expect(checked.gaps).toEqual([]);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it("catches a field the module does not declare, by 0.12's checker", async () => {
    const checked = await checkConnected(program('Nmae'));
    expect(checked.gaps).toEqual([]);
    expect(checked.diagnostics.some((d) => d.severity === 'error' && d.message.includes('Nmae'))).toBe(true);
  });

  it('without the platform\'s hosting, the same connection is a gap', async () => {
    const checked = await checkSource({ source: program('Nmae'), pin: '0.12.13', team: affinityTeam });
    expect(checked.gaps.map((gap) => gap.adapter)).toEqual(['affinity']);
  });
});
