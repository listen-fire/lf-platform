// The editor's language service for a release pin is the wasm's, against the
// run snapshot the lint uses: what the platform answers is what the binding
// answers over that snapshot. A line being typed does not stop the program
// from scanning, keystrokes on one line assemble the catalog once, a legacy
// pin is the browser's, and a pin nothing reads costs no catalog.

jest.mock('../catalog', () => ({ movementCatalogForTeam: jest.fn(), movementCatalogSnapshotForTeam: jest.fn() }));
jest.mock('../store', () => ({ getMovementRow: jest.fn() }));

import {
  LANGUAGE_VERSION,
  completionsAt,
  definitionAt,
  fromCatalogSnapshot,
  hoverAt as hoverInWasm,
  mockCatalogSnapshot,
  parseProgram,
  type CatalogSnapshot,
  type CompletionItem,
} from 'movement-lang';
import { getMovementCompletions } from 'legacy-lang';

import { movementCatalogForTeam, movementCatalogSnapshotForTeam } from '../catalog';
import { agentCompletionsAt, completeAt, defineAt, hoverAt, type EditorAnswer } from '../language_service';

const LIBRARY = 'export function greet(name: <text>) {\n  return "Hi ${name}"\n}\n';

const SNAPSHOT: CatalogSnapshot = {
  ...mockCatalogSnapshot({
    adapters: {
      manual: {
        constructionArgs: [],
        canFire: true,
        schema: {
          positions: { Invocation: { properties: { Text: 'text' }, edges: {} } },
          collections: {},
          writableRoots: {},
          eventPosition: 'Invocation',
          eventPositions: [{ position: 'Invocation' }],
        },
      },
      attio: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        connectActions: [{ kind: 'attio-list-picker', label: 'Connect a list' }],
        schema: {
          positions: { Companies: { properties: { Name: 'text' }, edges: {} } },
          collections: { Companies: { target: 'Companies' } },
          writableRoots: { Companies: { fields: { Name: 'text' }, resultShape: { externalId: 'text', Name: 'text' } } },
        },
      },
    },
    credentials: { acme_main: { adapters: ['attio'] } },
  }),
  files: { 'lib/greet': { source: LIBRARY } },
};

const PROGRAM = `import { attio } from adapters
import { acme_main } from credentials
import { greet } from "lib/greet"

crm = connect attio using acme_main

function hello(go: <manual-[:Invocation]->>) {
  write crm-[:Companies]-> {
    unique by (Name)
    Name: greet(go.Text)
  }
}

listen to manual fire hello
`;

const OPTIONS = { languageVersion: LANGUAGE_VERSION };

/** The offset just after the first `marker`. */
function after(source: string, marker: string): number {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker}`);
  return at + marker.length;
}

/** `source` with `inserted` written as a new line after `marker`'s line, and the offset at its end. */
function typed(source: string, marker: string, inserted: string): [string, number] {
  const at = after(source, marker);
  const lineEnd = source.indexOf('\n', at) + 1;
  return [source.slice(0, lineEnd) + inserted + '\n' + source.slice(lineEnd), lineEnd + inserted.length];
}

const assembled = movementCatalogForTeam as jest.MockedFunction<typeof movementCatalogForTeam>;
const skeleton = movementCatalogSnapshotForTeam as jest.MockedFunction<typeof movementCatalogSnapshotForTeam>;

// The live assembly scans the source for its constructions, and a source that
// does not parse throws, as `movementCatalogForTeam` does.
beforeEach(() => {
  assembled.mockReset();
  skeleton.mockReset();
  assembled.mockImplementation(async (_teamId, options = {}) => {
    if (options.source !== undefined) parseProgram(options.source, { languageVersion: options.languageVersion ?? LANGUAGE_VERSION });
    return {
      catalog: fromCatalogSnapshot(SNAPSHOT),
      resolveCredentialId: () => undefined,
      credentialsByName: new Map() as never,
      resolveFile: () => undefined,
      notes: [],
      positionArgOptions: {},
      instanceSchemas: [],
      gaps: [],
      runSnapshot: () => SNAPSHOT,
    };
  });
  skeleton.mockResolvedValue({ snapshot: SNAPSHOT } as never);
});

let teams = 0;
/** A team of its own per request, so the snapshot cache never carries between cases. */
function freshTeam(): string {
  teams += 1;
  return `team-${teams}`;
}

function answerOf<T>(answer: EditorAnswer<T>): T {
  if (answer.kind !== 'answer') throw new Error(`no answer: ${answer.kind}`);
  return answer.answer;
}

const asSet = (items: CompletionItem[]) => new Set(items.map((i) => JSON.stringify(i)));

describe('the editor language service for a release pin', () => {
  it("completes after `crm.` on a line that does not parse with the binding's items", async () => {
    const [text, at] = typed(PROGRAM, '    unique by (Name)', '    x = crm.');
    expect(() => parseProgram(text, OPTIONS)).toThrow();
    const found = answerOf(await completeAt({ teamId: freshTeam(), source: text, offset: at }));
    const binding = completionsAt(text, at, SNAPSHOT, OPTIONS);
    expect(binding.items.length).toBeGreaterThan(0);
    expect(asSet(found.items)).toEqual(asSet(binding.items));
    expect({ from: found.from, to: found.to }).toEqual({ from: binding.from, to: binding.to });
    // The source did not scan; the blanked one did.
    expect(assembled).toHaveBeenCalledTimes(2);
    expect(assembled.mock.calls[1]?.[1]?.source).not.toContain('crm.\n');
  });

  it('offers the adapter\'s connect action after the dot', async () => {
    const [text, at] = typed(PROGRAM, '    unique by (Name)', '    x = crm.');
    const found = answerOf(await completeAt({ teamId: freshTeam(), source: text, offset: at }));
    expect(found.items.filter((i) => i.connectAction !== undefined)).toEqual([
      {
        label: '+ Connect a list',
        kind: 'module',
        detail: 'attio',
        from: at,
        to: at,
        connectAction: { kind: 'attio-list-picker', adapter: 'attio', credential: 'acme_main' },
      },
    ]);
  });

  it('hovers a field with the markdown card', async () => {
    const offset = after(PROGRAM, 'go.Te');
    const card = answerOf(await hoverAt({ teamId: freshTeam(), source: PROGRAM, offset }));
    expect(card).toEqual(hoverInWasm(PROGRAM, offset, SNAPSHOT, OPTIONS));
    expect(card?.markdown.length).toBeGreaterThan(0);
    expect(PROGRAM.slice(card?.from, card?.to)).toBe('Text');
  });

  it('defines a library declaration as offsets into its text', async () => {
    const offset = after(PROGRAM, 'Name: gre');
    const found = answerOf(await defineAt({ teamId: freshTeam(), source: PROGRAM, offset }));
    if (found === null || 'module' in found) throw new Error(`not a place in a file: ${JSON.stringify(found)}`);
    expect(found.file).toBe('lib/greet');
    expect(LIBRARY.slice(found.from)).toMatch(/^export function greet/);
    expect(found).toEqual(definitionAt(PROGRAM, offset, SNAPSHOT, OPTIONS));
  });

  it('defines an imported adapter as its module', async () => {
    const offset = after(PROGRAM, 'connect att');
    expect(answerOf(await defineAt({ teamId: freshTeam(), source: PROGRAM, offset }))).toEqual({
      module: { namespace: 'adapters', name: 'attio' },
    });
  });

  it('answers a pin nothing reads with empty answers and assembles no catalog', async () => {
    const request = { teamId: freshTeam(), source: PROGRAM, offset: 10, languageVersion: '0.13.0' };
    expect(answerOf(await completeAt(request))).toEqual({ from: 10, to: 10, items: [] });
    expect(answerOf(await hoverAt(request))).toBeNull();
    expect(answerOf(await defineAt(request))).toBeNull();
    expect(assembled).not.toHaveBeenCalled();
    expect(skeleton).not.toHaveBeenCalled();
  });

  it('refuses a legacy pin: its language service is the browser\'s', async () => {
    const request = { teamId: freshTeam(), source: PROGRAM, offset: 10, languageVersion: '4' };
    expect(await completeAt(request)).toEqual({ kind: 'legacy-presentation', pin: '4' });
    expect(await hoverAt(request)).toEqual({ kind: 'legacy-presentation', pin: '4' });
    expect(await defineAt(request)).toEqual({ kind: 'legacy-presentation', pin: '4' });
    expect(assembled).not.toHaveBeenCalled();
  });

  it('assembles once for two completions on one line', async () => {
    const teamId = freshTeam();
    const [first, at] = typed(PROGRAM, '    unique by (Name)', '    x = crm.');
    await completeAt({ teamId, source: first, offset: at });
    const calls = assembled.mock.calls.length;
    const [second, there] = typed(PROGRAM, '    unique by (Name)', '    x = crm.Comp');
    const found = answerOf(await completeAt({ teamId, source: second, offset: there }));
    expect(assembled.mock.calls.length).toBe(calls);
    expect(asSet(found.items)).toEqual(asSet(completionsAt(second, there, SNAPSHOT, OPTIONS).items));
  });
});

describe("the agent's completions", () => {
  it("a release pin's are the wasm's over the run snapshot", async () => {
    const [text, at] = typed(PROGRAM, '    unique by (Name)', '    x = crm.');
    const found = await agentCompletionsAt({ teamId: freshTeam(), source: text, offset: at, pin: LANGUAGE_VERSION });
    const binding = completionsAt(text, at, SNAPSHOT, OPTIONS).items.map((i) => ({
      label: i.label,
      kind: i.kind,
      ...(i.detail !== undefined ? { detail: i.detail } : {}),
    }));
    expect(found.note).toBeUndefined();
    expect(new Set(found.completions.map((c) => JSON.stringify(c)))).toEqual(new Set(binding.map((c) => JSON.stringify(c))));
    expect(skeleton).not.toHaveBeenCalled();
  });

  it("a legacy pin's are legacy-lang's over the skeleton", async () => {
    const source = 'import { attio } from adapters\nimport { acme_main } from credentials\ncrm = attio(credentials: acme_main)\n';
    const offset = source.length;
    const found = await agentCompletionsAt({ teamId: freshTeam(), source, offset, pin: '4' });
    const legacy = getMovementCompletions(source, offset, SNAPSHOT, { languageVersion: '4' }).items.map((i) => ({
      label: i.label,
      kind: i.kind,
      ...(i.detail !== undefined ? { detail: i.detail } : {}),
    }));
    expect(legacy.length).toBeGreaterThan(0);
    expect(found).toEqual({ completions: legacy });
    expect(skeleton).toHaveBeenCalledTimes(1);
    expect(assembled).not.toHaveBeenCalled();
  });

  it('a pin nothing reads gets the note and no catalog', async () => {
    const found = await agentCompletionsAt({ teamId: freshTeam(), source: PROGRAM, offset: 10, pin: '0.13.0' });
    expect(found.completions).toEqual([]);
    expect(found.note).toContain('0.13.0');
    expect(assembled).not.toHaveBeenCalled();
    expect(skeleton).not.toHaveBeenCalled();
  });
});
