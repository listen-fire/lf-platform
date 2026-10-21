// Language version 1's conformance corpus: v0.6.0's own movement-lang tests,
// verbatim under `__conformance__/v1/`, run against the current code under
// language version 1. A failure is a v0.6.0 behaviour the current code no
// longer preserves. The corpus files are never edited; a test that asserted a
// since-refactored internal shape is listed in `__conformance__/v1/triage.cjs`.
// Run via `pnpm test:conformance:v1` in this package.
const path = require('path');
const borrowed = require('./jest.config.borrowed.cjs');

const [tsJest, tsJestOptions] = borrowed.transform['^.+\\.tsx?$'];

module.exports = {
  ...borrowed,
  testMatch: ['<rootDir>/__conformance__/v1/**/*.unit.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  resolver: path.join(__dirname, 'conformance/resolver.cjs'),
  setupFilesAfterEnv: [
    path.join(__dirname, 'conformance/v1.setup.cjs'),
    path.join(__dirname, 'conformance/triage.setup.cjs'),
  ],
  // The corpus is typed against v0.6.0's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': [tsJest, { ...tsJestOptions, isolatedModules: true }] },
};
