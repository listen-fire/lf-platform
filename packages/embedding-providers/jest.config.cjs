const base = require('../../jest.config.base.cjs');

module.exports = base(__dirname, {
  testEnvironmentOptions: { customExportConditions: ['node', 'node-addons', 'movement-engine-internals'] },
});
