// PreToolUse guard for Bash. Blocks the standing prohibitions that have
// caused incidents — deterministically, instead of relying on CLAUDE.md.
// Exit 2 + stderr = block the call and feed the message back to the agent.

const input = JSON.parse(await new Promise((resolve) => {
  let data = '';
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => resolve(data));
}));

const command = input?.tool_input?.command ?? '';

// A `jest` run from the repo root (bare, `npx`, `pnpm exec`) with nothing to
// scope it runs every package's suites. Packages run theirs via `pnpm test`.
const unscopedRootJest = (c) =>
  c.split(/&&|\|\||[;|\n]/).some((segment) => {
    const match = segment.match(/(?:^|\s)(?:npx\s+|pnpm\s+(?:exec\s+)?)?jest(?:\s+(.*))?$/);
    if (!match) return false;
    const args = match[1] ?? '';
    return !/--config|\s-c\s|--testPathPattern|--findRelatedTests|--testNamePattern|--projects|\s-t\s/.test(` ${args}`) &&
      !args.split(/\s+/).some((a) => a && !a.startsWith('-'));
  });

const rules = [
  {
    test: (c) =>
      /\bpnpm(\s+-r)?\s+test:unit\b/.test(c) &&
      !/--testPathPattern|--findRelatedTests|--testNamePattern|\s-t\s/.test(c),
    message:
      'Blocked: unscoped `pnpm test:unit` kills the jest cache and runs hundreds of tests. ' +
      'Scope it with --testPathPattern <file> or --findRelatedTests <changed-file>. ' +
      'The full suite runs only via the ship gate (see CLAUDE.md "Done vs shippable").',
  },
  {
    test: unscopedRootJest,
    message:
      'Blocked: a bare root `jest` runs every package\'s suites. ' +
      'Run a package\'s set with `pnpm --filter <package> test`, or scope jest with ' +
      '--config <package>/jest.config.cjs, --testPathPattern or a file path.',
  },
  {
    test: (c) => /packages\/movement-lang/.test(c) && /\b(pnpm|npm|yarn)\b.*\bbuild\b/.test(c),
    message:
      'Blocked: never build packages/movement-lang in place — emitted .js files shadow the .ts ' +
      'sources and break jest resolution. Test it with `pnpm --filter @listen-fire/movement-lang test`.',
  },
  {
    test: (c) => /\bgit\s+clean\b.*-[a-zA-Z]*[xX]/.test(c),
    message:
      'Blocked: `git clean -x/-X` deletes ignored build state other sessions depend on. ' +
      'Delete the specific artifacts you mean by path.',
  },
  {
    test: (c) => /until\s+!\s*ps\s+-p\b/.test(c),
    message:
      'Blocked: polling for process death with `until ! ps -p` loops. ' +
      'Use run_in_background and wait for the completion notification instead.',
  },
];

for (const rule of rules) {
  if (rule.test(command)) {
    process.stderr.write(rule.message);
    process.exit(2);
  }
}
process.exit(0);
