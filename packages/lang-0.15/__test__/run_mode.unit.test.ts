// The dry_run⇄live axis a 0.15 listen's row keeps, read off 0.15's own parse:
// the whole movement rehearses exactly when every instance it writes to was
// constructed `dry_run: true`, through called functions and traversal aliases.

import { parseProgram } from '@listen-fire/movement-lang';

import { movementWriteRunMode } from '../lane/run_mode';

const PIN = '0.15.3';
const modeOf = (source: string, movement: string) => movementWriteRunMode({ program: parseProgram(source, { languageVersion: PIN }), movement, pin: PIN }).mode;

const HEADER = (slackConfig: string) =>
  'import { manual, slack, attio } from adapters\nimport { bot, acme } from credentials\n' +
  `go = connect manual\nslackbot = connect slack using bot${slackConfig}\ncrm = connect attio using acme\n`;
const REHEARSING = ' { dryRun: true }';

describe("a 0.15 movement's run mode, by 0.15's parse", () => {
  it('rehearses a write delegated to a called function', () => {
    const source =
      HEADER(REHEARSING) +
      'function post() {\n  slackbot-[ch:Channels WHERE ch.Name == "daily"]-> {\n    write ch-[:Messages]-> { Message: "hi" }\n  }\n}\n' +
      'function pressed(i: <go-[:Invocation]->>) {\n  post()\n}\n' +
      'listen to go-[:Invocation]-> fire pressed\n';
    expect(modeOf(source, 'pressed')).toBe('dry_run');
  });

  it('rehearses a write anchored on a traversal alias, which the alias owes to its head', () => {
    const source =
      HEADER(REHEARSING) +
      'function pressed(i: <go-[:Invocation]->>) {\n  slackbot-[ch:Channels WHERE ch.Name == "daily"]-> {\n    write ch-[:Messages]-> { Message: "hi" }\n  }\n}\n' +
      'listen to go-[:Invocation]-> fire pressed\n';
    expect(modeOf(source, 'pressed')).toBe('dry_run');
  });

  it('owes an expression-rooted head to the owner of the handle its expression reads', () => {
    const source =
      HEADER(REHEARSING) +
      'function pressed(i: <go-[:Invocation]->>) {\n  slackbot-[ch:Channels WHERE ch.Name == "daily"]-> {\n    AT([ch], 0)-[m:Messages]-> {\n      write m-[:Replies]-> { Message: "hi" }\n    }\n  }\n}\n' +
      'listen to go-[:Invocation]-> fire pressed\n';
    expect(modeOf(source, 'pressed')).toBe('dry_run');
  });

  it('runs live when the instance it writes to is not constructed dry_run', () => {
    const source =
      HEADER('') +
      'function pressed(i: <go-[:Invocation]->>) {\n  slackbot-[ch:Channels WHERE ch.Name == "daily"]-> {\n    write ch-[:Messages]-> { Message: "hi" }\n  }\n}\n' +
      'listen to go-[:Invocation]-> fire pressed\n';
    expect(modeOf(source, 'pressed')).toBe('live');
  });

  it('reads mixed when a rehearsing and a live instance are both written', () => {
    const source =
      HEADER(REHEARSING) +
      'function post() {\n  slackbot-[ch:Channels WHERE ch.Name == "daily"]-> {\n    write ch-[:Messages]-> { Message: "hi" }\n  }\n  write crm-[:Companies]-> { Name: "Acme" }\n}\n' +
      'function pressed(i: <go-[:Invocation]->>) {\n  post()\n}\n' +
      'listen to go-[:Invocation]-> fire pressed\n';
    expect(modeOf(source, 'pressed')).toBe('mixed');
  });

  it('runs live when the movement named is not in the file', () => {
    expect(modeOf(HEADER(REHEARSING), 'absent')).toBe('live');
  });
});
