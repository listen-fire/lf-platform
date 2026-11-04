// A 0.12 automation's picture and authoring help come from 0.12's own language
// and handbook, in 0.12's words: nothing here reads under a later release.

import { catalogOf, checkSource, connectionsDigest, describeSystem, handbookFrontSection, handbookOf, outlineOf, searchHandbook, storyOf } from '..';
import type { ModulePlatform } from '../lane/run_types';
import type { TeamFacts, TeamFile } from '../lane/types';

function team(files: TeamFile[] = []): TeamFacts {
  return {
    credentials: [],
    files,
    connectOf: () => 'oauth',
    kgChangeWebhooks: false,
    mcpEnabled: false,
    whatsappNumber: null,
  };
}

const ECHO_012 = 'function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual fire echo\n';
const ECHO_015 = 'function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual-[:Invocations]-> fire echo\n';

const DEPLOYMENT = { kgChangeWebhooks: false, mcpEnabled: false, whatsappNumber: null };

describe("a 0.12 program's picture", () => {
  it("is drawn from 0.12's analysis: its trigger, its steps and its systems' own words", async () => {
    const drawn = await storyOf({ source: ECHO_012, pin: '0.12.13', team: team(), name: 'Echo' });
    if (!drawn.ok) throw new Error(`no picture: ${JSON.stringify(drawn.problems)}`);
    expect(drawn.story.movement).toMatchObject({ name: 'Echo', validity: { status: 'valid' } });
    expect(drawn.story.triggers).toEqual([expect.objectContaining({ fires: 'echo', adapterType: 'manual' })]);
    expect(drawn.words.systems.manual?.label).toEqual(expect.any(String));
    // What crosses survives a wire.
    expect(JSON.parse(JSON.stringify(drawn.story))).toEqual(drawn.story);
  });

  it('text only a later release reads has no picture, and says why', async () => {
    const drawn = await storyOf({ source: ECHO_015, pin: '0.12.13', team: team(), name: 'Echo' });
    expect(drawn).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: 'MOV_PARSE', severity: 'error', message: expect.stringContaining("Expected 'fire' after 'listen to manual'") })],
    });
  });

  it("carries the platform's stored ruling, as production did", async () => {
    const drawn = await storyOf({ source: ECHO_012, pin: '0.12.13', team: team(), name: 'Echo', validityStatus: 'unverified' });
    if (!drawn.ok) throw new Error('no picture');
    expect(drawn.story.movement.validity.status).toBe('unverified');
  });

  it('a system it could not read makes the picture unverified, naming the gap', async () => {
    const source =
      'import { attio } from adapters\nimport { acme_main } from credentials\ncrm = connect attio using acme_main\n' +
      'function f(go: <manual-[:Invocation]->>) {\n  write crm-[:Companies]-> {\n    unique by (Name)\n    Name: go.Text\n  }\n}\nlisten to manual fire f\n';
    const drawn = await storyOf({
      source,
      pin: '0.12.13',
      team: { ...team(), credentials: [{ id: 'c1', name: 'acme_main', type: 'ATTIO' }] },
      name: 'F',
    });
    if (!drawn.ok) throw new Error(`no picture: ${JSON.stringify(drawn.problems)}`);
    expect(drawn.gaps.map((gap) => gap.adapter)).toEqual(['attio']);
    expect(drawn.story.movement.validity.status).toBe('unverified');
    expect(drawn.story.records).toEqual([expect.objectContaining({ action: expect.any(String) })]);
  });

  it('an import across versions is in the verdict the picture carries', async () => {
    const importer = 'import { echo } from "lib"\nlisten to manual fire echo\n';
    const drawn = await storyOf({
      source: importer,
      pin: '0.12.13',
      team: team([{ name: 'lib', source: 'export function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\n', languageVersion: '0.15.1' }]),
      name: 'Importer',
    });
    if (!drawn.ok) throw new Error(`no picture: ${JSON.stringify(drawn.problems)}`);
    expect(drawn.story.movement.validity.problems.map((problem) => problem.code)).toContain('MOV_IMPORT_LANGUAGE_VERSION');
  });
});

describe('the handbook a 0.12 automation is taught from', () => {
  const book = handbookOf(DEPLOYMENT);

  it('is handbook 0.12.8', () => {
    expect(book.release).toBe('0.12.8');
  });

  it("carries its modules' and plugins' own sections", () => {
    const ids = book.chapters.map((chapter) => chapter.id);
    expect(ids).toEqual(expect.arrayContaining(['foundations', 'system:manual', 'system:cron', 'system:kg', 'plugin:research']));
  });

  it('teaches the 0.12 listen and never the spelling 0.13 introduced', () => {
    const manual = book.chapters.find((chapter) => chapter.id === 'system:manual');
    expect(manual?.content).toContain('to manual fire');
    expect(manual?.content).not.toContain('-[:Invocations]->');
  });

  it('answers front page anchors and refuses unknown ones', () => {
    expect(handbookFrontSection('build-loop')).toMatchObject({ ok: true });
    expect(handbookFrontSection('no-such-anchor')).toMatchObject({ ok: false });
  });

  it('searches its own assembled book', () => {
    const found = searchHandbook({ query: 'manual' }, DEPLOYMENT);
    expect(found.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(found)).not.toContain('-[:Invocations]->');
  });

  it('every listen a searched example shows reads under 0.12', async () => {
    const found = searchHandbook({ query: 'listen manual' }, DEPLOYMENT);
    const shown = found.results.map((result) => result.example).filter((example): example is string => example !== undefined);
    for (const example of shown) expect(example).not.toContain('-[:Invocations]->');
  });
});

describe('the systems a 0.12 automation is written against', () => {
  const modules = new Proxy({} as ModulePlatform, {
    get: () => {
      throw new Error('no connected system is read in these tests');
    },
  });

  it("the catalog is 0.12's: its construction, and no 0.15 spelling", async () => {
    const view = await catalogOf(team());
    expect(Object.keys(view.adapters)).toEqual(expect.arrayContaining(['manual', 'cron', 'attio']));
    expect(view.adapters.attio).toMatchObject({ requiresCredential: true });
    expect(JSON.stringify(view)).not.toContain('writtenAs');
  });

  it('a static surface reads whole, with the fields 0.12 described', async () => {
    const text = await describeSystem({ team: team(), teamId: 't', modules, system: 'manual' });
    expect(text).toContain('### manual');
    expect(text).toContain('Invocation');
    expect(text).not.toContain('Invocations');
  });

  it('a system the team has not connected says so, and reads nothing', async () => {
    const text = await describeSystem({ team: team(), teamId: 't', modules, system: 'attio' });
    expect(text).toContain('no connection for it');
  });

  it('a name 0.12 does not know is named', async () => {
    const text = await describeSystem({ team: team(), teamId: 't', modules, system: 'nope' });
    expect(text).toContain('Not a system language 0.12 knows');
  });

  it('the digest describes what it can and names what the team has not connected', async () => {
    const digest = await connectionsDigest({ team: team(), teamId: 't', modules });
    expect(digest).toContain('### manual');
    expect(digest).toMatch(/Not connected on this team:.*attio/);
  });

  it('the connection the help shows reads under 0.12', async () => {
    const withAttio: TeamFacts = { ...team(), credentials: [{ id: 'c1', name: 'acme_main', type: 'ATTIO' }] };
    const text = await describeSystem({ team: withAttio, teamId: 't', modules, system: 'attio' }).catch((error: unknown) => String(error));
    const shown = /`(connect attio using \w+)`/.exec(text)?.[1];
    expect(shown).toBe('connect attio using acme_main');
    const checked = await checkSource({
      source: `import { attio } from adapters\nimport { acme_main } from credentials\ncrm = ${shown}\n`,
      pin: '0.12.13',
      team: withAttio,
    });
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe("a 0.12 text's listens, as the panel and an opened automation read them", () => {
  it('reads the listen 0.12 spells, with its facets', () => {
    expect(outlineOf({ source: ECHO_012, pin: '0.12.13' })).toEqual({
      active: [{ instance: 'manual', adapter: null, configKey: null, traversal: false, address: null, movement: 'echo', startLine: 4, endLine: 4 }],
      paused: [],
      adapters: {},
      facets: { listenerCount: 1, runnableOnDemand: true, isAutomation: true, exportedMovementCount: 0, exportedShapeCount: 0, isLibrary: false },
    });
  });

  it('reads a commented-out listen as paused, by 0.12\'s parser', () => {
    const paused = outlineOf({ source: ECHO_012.replace('listen to', '# listen to'), pin: '0.12.13' });
    expect(paused.active).toEqual([]);
    expect(paused.paused).toEqual([expect.objectContaining({ movement: 'echo', startLine: 4, endLine: 4 })]);
  });

  it('text only a later release reads does not parse here', () => {
    const outline = outlineOf({ source: ECHO_015, pin: '0.12.13' });
    expect(outline.active).toBeNull();
    expect(outline.facets.isAutomation).toBe(false);
  });

  it('a commented-out later spelling is not offered as a paused listen', () => {
    expect(outlineOf({ source: `${ECHO_012}# listen to manual-[:Invocations]-> fire echo\n`, pin: '0.12.13' }).paused).toEqual([]);
  });

  it('a connected instance names its adapter, an import alias resolved', () => {
    const outline = outlineOf({ source: 'import { `@lf/email` as mail } from adapters\ninbox = connect mail\nfunction f(m: <inbox-[:message]->>) {\n  return 1\n}\nlisten to inbox { key: "deals" } fire f\n', pin: '0.12.13' });
    expect(outline.active).toEqual([expect.objectContaining({ instance: 'inbox', configKey: 'deals', movement: 'f' })]);
    expect(outline.facets.runnableOnDemand).toBe(false);
  });
});
