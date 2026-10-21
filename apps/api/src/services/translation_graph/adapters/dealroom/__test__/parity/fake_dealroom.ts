// The fake-channels Dealroom, booted on its own throwaway database, for
// RECORDING the parity fixture only (replay needs no provider). A child
// process under fake-channels' own tsx, because its store needs
// better-sqlite3, which this app does not load.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// The fakes are a package; their tsx is resolved from it, as the package's
// own bin runs it (an installed package has no node_modules/.bin of its own).
const FAKE_CHANNELS = dirname(require.resolve('@listen-fire/fake-channels/package.json'));
const TSX = require.resolve('tsx/cli', { paths: [FAKE_CHANNELS] });

const BOOT = `
const express = require('express');
const { EntityStore } = require('./src/store');
const { seedDefaults } = require('./src/seed');
const { dealroomRoutes } = require('./src/routes/dealroom');
const store = new EntityStore(process.env.PARITY_DB);
seedDefaults(store);
const app = express();
app.use(express.json());
app.use('/dealroom', dealroomRoutes(store));
const server = app.listen(0, '127.0.0.1', () => console.log('listening ' + server.address().port));
`;

export async function bootFakeDealroom(): Promise<{ baseUrl: string; stop(): void }> {
  const db = join(mkdtempSync(join(tmpdir(), 'dealroom-parity-')), 'fake-channels.db');
  const child = spawn(process.execPath, [TSX, '--eval', BOOT], {
    cwd: FAKE_CHANNELS,
    env: { ...process.env, PARITY_DB: db },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('fake dealroom did not start within 20s')), 20_000);
    child.once('exit', (code) => reject(new Error(`fake dealroom exited (${code})`)));
    if (child.stdout === null) return;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const match = /^listening (\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}/dealroom`, stop: () => child.kill() };
}
