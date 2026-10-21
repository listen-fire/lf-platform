const base = require('../../jest.config.base.cjs');

module.exports = base(__dirname, {
  maxWorkers: '50%',
  // Older language versions' corpora run under their own version, via
  // jest.conformance.v<n>.cjs — never under the current one.
  testPathIgnorePatterns: ['/node_modules/', '/__conformance__/'],
});
