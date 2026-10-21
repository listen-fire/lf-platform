const base = require('../../jest.config.base.cjs');

module.exports = base(__dirname, {
  maxWorkers: '50%',
});
