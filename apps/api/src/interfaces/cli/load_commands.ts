// clime loads a command module with `require`, and when that throws it retries
// the file as an ES module import and reports the retry's failure instead. On a
// Node that strips TypeScript types itself (22.18 and later), importing a
// command's `.ts` source dies on its decorators, so whatever really stopped
// the command loading (a type error, a missing variable, a bad import) never
// reaches the operator: every command fails with the same syntax error.
//
// So the modules a run will load are required here first, where their own
// error escapes. A module that loads is cached, and clime's require finds it.

import fs from 'node:fs';
import path from 'node:path';

/** clime's own test for a word that can name a command. */
const COMMAND_NAME = /^[\w\d]+(?:-[\w\d]+)*$/;

/**
 * Require the command modules `argv` will have clime load: the named
 * command's, or every command's when none is named (the listing loads each
 * for its description). An unknown name loads nothing, for clime to report.
 */
function requireCommandModules(input: { commandsDir: string; extension: string; argv: string[] }): void {
  const name = input.argv[2];
  const files =
    name !== undefined && COMMAND_NAME.test(name)
      ? [`${name}${input.extension}`]
      : fs.readdirSync(input.commandsDir).filter((file) => file.endsWith(input.extension) && !file.endsWith('.d.ts'));
  for (const file of files) {
    const modulePath = path.join(input.commandsDir, file);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (fs.existsSync(modulePath)) require(modulePath);
  }
}

export { requireCommandModules };
