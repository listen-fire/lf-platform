#!/usr/bin/env node
import path from 'node:path';

import { CLI, Shim } from 'clime';

import { requireCommandModules } from './load_commands';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runningInTSNode = (process as any)[Symbol.for('ts-node.register.instance')] !== undefined;
if (runningInTSNode) {
  CLI.commandModuleExtension = '.ts';
}
const commandsDir = path.join(__dirname, 'commands');
requireCommandModules({ commandsDir, extension: CLI.commandModuleExtension, argv: process.argv });

const cli = new CLI('cli', commandsDir);
const shim = new Shim(cli);

void shim.execute(process.argv).finally(() => {});
