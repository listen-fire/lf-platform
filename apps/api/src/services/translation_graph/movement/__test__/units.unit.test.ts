// The run host's units on the platform: from language 0.12 a file listens to
// `cron` and `manual` with no import and no construction (in 0.13 on their
// listenable edges, `Invocations` and `Ticks`), and a manual listen is the
// "Run now" target. Before 5 a unit is no unit. What each listen plans is the
// engine's (`plannedListensOf`), held by the listen plan suites.

import { LANGUAGE_VERSION } from 'movement-lang';
import { parseProgram } from 'legacy-lang';
import { manualListenerMovements } from '../files';

const CURRENT = [
  'function backfill(run: <manual-[:Invocations]->>) {',
  '  return 1',
  '}',
  'listen to manual-[:Invocations]-> fire backfill',
  'function digest(t: <cron-[:Ticks]->>) {',
  '  return 1',
  '}',
  'listen to cron-[:Ticks]-> fire digest',
  '',
].join('\n');

describe('run host units', () => {
  it('a manual listen is a Run now target from version 5', () => {
    expect(manualListenerMovements(parseProgram(CURRENT, { languageVersion: LANGUAGE_VERSION }), { languageVersion: LANGUAGE_VERSION })).toEqual(['backfill']);
  });

  it('there is no unit before version 5', () => {
    const v4 = 'movement go(run: <manual-[:Invocation]->>) {\n  x = 1\n}\nlisten to manual {} fire go\n';
    expect(manualListenerMovements(parseProgram(v4, { languageVersion: '4' }), { languageVersion: '4' })).toEqual([]);
  });
});
