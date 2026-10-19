// The file kv's compare-and-set holds across processes sharing its directory:
// several processes counting up one key by compare-and-set lose no count.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileKv } from '../file_kv';

function countUp(dir: string, times: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, 'fixtures/count_up.cjs'), dir, String(times)], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`count_up exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`))));
  });
}

describe('a file kv shared by several processes', () => {
  it('loses no compare-and-set: each one lands once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'module-kv-shared-'));
    await Promise.all([countUp(dir, 15), countUp(dir, 15), countUp(dir, 15)]);
    expect(await fileKv(dir, 'team-a').get('count')).toBe(45);
  }, 60_000);
});
