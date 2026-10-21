// Post-processes the tRPC declaration bundle tsup emits into the shared
// `@listen-fire/trpc` package: tsup writes each top-level declaration
// module-private, so every one is re-exported for consumers. Node rather than
// `sed -i`, whose in-place flag is spelled differently on BSD and GNU. Substitutions are per line, first match only,
// matching what the sed pipeline they replace did.

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: codegen_trpc_postprocess.js <types.ts>');
  process.exit(1);
}

const processed = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .map((line) =>
    line
      .replace(/^type /, 'export type ')
      .replace(' type TRPCRouter, ', ' ')
      .replace(/^declare enum /, 'export const enum ')
      .replace(/^interface /, 'export interface '),
  )
  .join('\n');

fs.writeFileSync(file, processed);
