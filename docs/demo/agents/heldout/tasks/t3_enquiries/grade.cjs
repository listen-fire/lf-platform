// T3's grading, called by ../../grade.cjs: the five deliveries posted, in
// order, through @lf/webhook's door (`listen-fire run --webhook`, as
// `listen-fire serve` takes a POST, unsigned as the connection says), then
// the Enquiries table, row by row.
const fs = require('fs');
const path = require('path');
const { deliveries, EXPECTED, dayFrom } = require('./events.cjs');
const { EARLIER } = require('./world.cjs');

const EARLIER_ID = EARLIER.fields['Enquiry Id'];

module.exports = async function grade({ lf, expect, text, world, FAKES, scratch }) {
  await world.reset(FAKES, 't3');
  const now = Date.now();
  deliveries(now).forEach((body, i) => {
    const file = path.join(scratch, `t3-delivery-${i + 1}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    lf(['run', '--webhook', 'webhook', '--install', 'site_form', '--body', file, '--header', 'content-type:application/json']);
  });
  const rows = await world.rows(FAKES, 'appEVENTS', 'tblENQUIRIES');
  expect('five enquiries: the earlier one and one per enquiry id', rows.length === 5, rows.map((r) => r.fields));
  const earlier = rows.filter((r) => text(r.fields['Enquiry Id']) === EARLIER_ID);
  expect('the earlier enquiry is as it was', earlier.length === 1 && Object.entries(EARLIER.fields).every(([k, v]) => text(earlier[0].fields[k]) === text(v)), earlier.map((r) => r.fields));
  for (const [id, want] of Object.entries(EXPECTED)) {
    const mine = rows.filter((r) => text(r.fields['Enquiry Id']) === id);
    if (mine.length !== 1) {
      expect(`enquiry ${id}: one row`, false, `${mine.length} rows`);
      continue;
    }
    const got = mine[0].fields;
    const { inDays, ...fields } = want;
    for (const [field, value] of Object.entries(fields)) {
      const same = typeof value === 'number' ? Number(got[field]) === value : text(got[field]) === value;
      expect(`enquiry ${id}: ${field}`, same, { want: value, got: got[field] ?? null });
    }
    const date = dayFrom(now, inDays);
    expect(`enquiry ${id}: Event Date`, text(got['Event Date']).slice(0, 10) === date, { want: date, got: got['Event Date'] ?? null });
  }
};
