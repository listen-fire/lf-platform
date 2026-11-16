// A 0.15 program checked by 0.15's own checker, against the catalog 0.15's own
// modules describe: never this release's catalog, which 0.15's checker cannot
// read (a 0.16 snapshot carries fields 0.15 refuses).

import { checkSource, outlineOf, storyOf } from '..';
import type { TeamFacts } from '../lane/types';
import type { ModulePlatform } from '../lane/run_types';

const refused = async (): Promise<never> => {
  throw new Error('not part of this test');
};

/** The platform's hosting of 0.15's modules, as far as reading a connection
 *  needs it: Slack describes its records without calling Slack. */
const modules = (): ModulePlatform => ({
  hostFor: () => ({
    credential: { name: 'bot', fields: async () => ({ botToken: 'xoxb-test' }), update: async () => {} },
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
    systemRecords: () => ({
      failedRuns: refused,
      pausedRuns: refused,
      strandedWaits: refused,
      releases: refused,
      unjudgedArrivals: refused,
      webBaseUrl: async () => null,
    }),
    remoteInstall: refused,
    readDocument: refused,
  },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  validateResults: false,
});
const connected = { teamId: 'team-1', modules: modules() };

function team(): TeamFacts {
  return {
    credentials: [{ id: 'c1', name: 'deals', type: 'SLACK' }],
    files: [],
    connectOf: () => 'oauth',
    kgChangeWebhooks: false,
    mcpEnabled: false,
    whatsappNumber: null,
  };
}

/** A Slack listen as 0.15 reads it, its movement asking who acted (`@user_email`,
 *  which 0.16 retired). */
const SLACK_015 =
  'import { slack } from adapters\nimport { deals } from credentials\nchat = connect slack using deals\n' +
  'function intake(m: <chat-[:Message]->>) {\n  who = @user_email\n  said = m.Message\n}\n' +
  'listen to chat-[:Channels]->-[m:Messages WHERE m.Message != ""]-> fire intake\n';

const check = (source: string) => checkSource({ source, pin: '0.15.3', team: team(), connected });

describe("a 0.15 program, by 0.15's checker", () => {
  it('reads a Slack listen and @user_email clean, its listen counted', async () => {
    const checked = await check(SLACK_015);
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(checked.firedMovements).toEqual(['intake']);
  });

  it("checks a field against Slack's records as 0.15's module describes them", async () => {
    const checked = await check(SLACK_015.replace('m.Message', 'm.Messagee'));
    expect(checked.diagnostics).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('Messagee') })]);
  });

  it("does not know a field only 0.16's Slack has", async () => {
    const checked = await check(SLACK_015.replace('m.Message', 'm.`User Email`'));
    expect(checked.diagnostics).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('User Email') })]);
  });

  it('refuses a 0.16 pin, as 0.15 refuses a release it does not read', async () => {
    const checked = await checkSource({ source: SLACK_015, pin: '0.16.0', team: team() });
    expect(checked.diagnostics).toEqual([expect.objectContaining({ code: 'MOV_PARSE', severity: 'error', message: expect.stringContaining('0.16.0') })]);
  });

  it('outlines its listens by its own parser', () => {
    const outline = outlineOf({ source: SLACK_015, pin: '0.15.3' });
    expect(outline.active).toEqual([expect.objectContaining({ instance: 'chat', movement: 'intake', adapter: 'slack' })]);
  });

  it('pictures its story by its own story analysis', async () => {
    const story = await storyOf({ source: SLACK_015, pin: '0.15.3', team: team(), connected, name: 'intake' });
    expect(story.ok).toBe(true);
    if (story.ok) expect(story.story.triggers).toEqual([expect.objectContaining({ adapterType: 'slack', fires: 'intake' })]);
  });
});
