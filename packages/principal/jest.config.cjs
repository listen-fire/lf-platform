const base = require('../../jest.config.base.cjs');

module.exports = base(__dirname, {
  // Type-checked (no isolatedModules): this package keeps ts-jest's diagnostics on.
  transform: {
    '^.+\\.tsx?$': [
      base.TS_JEST,
      { tsconfig: { target: 'es2022', module: 'commonjs', esModuleInterop: true, strict: true } },
    ],
  },
});
