// A process loads a carried version's packages only when it first has work for
// that version: asking the registry what a version provides loads nothing of
// it, and a cold-started process that then runs one 0.12 segment loads 0.12
// then, and runs it. Measured in a fresh process (scripts/cold_start.cjs), so
// nothing another test loaded counts.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

interface Phase {
  phase: 'registry' | 'loaded' | 'ran';
  carriedModulesLoaded: number;
  msSinceStart: number;
  rssGrowthMb: number;
  outcome?: string;
}

it('loads 0.12 only when a 0.12 run arrives, then runs it', () => {
  const out = execFileSync(
    process.execPath,
    ['-r', require.resolve('ts-node/register/transpile-only'), path.join(ROOT, 'scripts/cold_start.cjs')],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const phases: Phase[] = out
    .split('\n')
    .filter((line) => line.startsWith('{"phase"'))
    .map((line) => JSON.parse(line));
  expect(phases.map((p) => p.phase)).toEqual(['registry', 'loaded', 'ran']);
  expect(phases[0]!.carriedModulesLoaded).toBe(0);
  expect(phases[1]!.carriedModulesLoaded).toBeGreaterThan(0);
  expect(phases[2]!.outcome).toBe('ran');
}, 120_000);
