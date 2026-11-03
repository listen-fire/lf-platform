// T4's example: the tick the schedule's first morning fires (07:00 UTC, the
// one the grader's first drain reaches), as the cron unit hands it over
// (crates/lf/src/units.rs).
//
//   node events.cjs <out dir>   writes example.json
const fs = require('fs');
const path = require('path');
const { firstMorning } = require('./world.cjs');

if (require.main === module) {
  const [out] = process.argv.slice(2);
  const at = new Date(firstMorning() - 30_000).toISOString();
  const tick = { external: 'cron', event: { arrivals: [{ edge: 'Ticks', identity: `tick:0 7 * * *:UTC:${at}`, landing: { recordType: 'Tick', fields: { 'Fired at': at, Schedule: '0 7 * * *', Zone: 'UTC' } }, occurredAt: at }] } };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'example.json'), `${JSON.stringify(tick)}\n`);
}
