// The one jest setup every package's `jest.config.cjs` builds on:
// `module.exports = require('../../jest.config.base.cjs')(__dirname, overrides?)`.
// Jest and ts-jest are the root install's, so no package carries its own.
// Transpile only: types are owned by `pnpm code:type-check`.
const path = require('path');

const ROOT_NODE_MODULES = path.join(__dirname, 'node_modules');
const TS_JEST = require.resolve('ts-jest');

module.exports = (rootDir, overrides = {}) => ({
  rootDir,
  testMatch: ['**/*.unit.test.ts'],
  testEnvironment: 'node',
  maxWorkers: 1,
  clearMocks: true,
  // Sources are the truth: resolve `.ts` before any stray compiled `.js`.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': [
      TS_JEST,
      {
        tsconfig: { target: 'es2022', module: 'commonjs', esModuleInterop: true, strict: true },
        isolatedModules: true,
        diagnostics: false,
      },
    ],
  },
  modulePaths: [ROOT_NODE_MODULES],
  ...overrides,
});

module.exports.TS_JEST = TS_JEST;
