// T3's enquiries, as the website's form posts them to the webhook: the
// authoring session's example, and the grader's five (made when it grades, so
// "less than 14 days after the enquiry was sent" is read against the day the
// grader runs, whichever of the run's clock or `submitted_at` a program reads).
//
//   node events.cjs <out dir>
// writes example.body.json (the JSON the session is shown) and example.json
// (the same delivery as `listen-fire run --event` takes it: the arrival
// @lf/webhook's door makes of it, modules/webhook/adapter.ts).
const fs = require('fs');
const path = require('path');

const DAY = 86_400_000;
const dayFrom = (now, days) => new Date(now + days * DAY).toISOString().slice(0, 10);
const enquiry = (now, id, name, email, inDays, guests, message) => ({
  enquiry_id: id,
  submitted_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  name,
  email,
  event_date: dayFrom(now, inDays),
  guests,
  message,
});

const example = (now = Date.now()) => enquiry(now, 'enq_1042', 'Sofia Lind', 'events@kestrel.vc', 21, 60, 'Partner offsite, we will need a projector.');

/** The grader's deliveries, in order; the fifth is the third sent again. */
function deliveries(now = Date.now()) {
  const ben = enquiry(now, 'enq_2003', 'Ben Okafor', 'ben@northwind.io', 60, 180, 'Product launch with a standing reception.');
  return [
    enquiry(now, 'enq_2001', 'Ana Ruiz', 'ana@brightside.co', 40, 80, 'End of year party for the studio.'),
    enquiry(now, 'enq_2002', 'Jonas Weber', 'jonas@weber-gmbh.de', 5, 30, 'Last-minute board dinner.'),
    ben,
    enquiry(now, 'enq_2004', 'Mei Chen', 'mei@lanternhq.com', 9, 220, 'Conference afterparty.'),
    ben,
  ];
}

/** What the Enquiries table must hold for each enquiry id afterwards, Event
 *  Date as days from the grading day. */
const EXPECTED = {
  enq_2001: { Name: 'Ana Ruiz', Email: 'ana@brightside.co', inDays: 40, Guests: 80, 'Assigned To': 'Marco', Priority: 'Normal' },
  enq_2002: { Name: 'Jonas Weber', Email: 'jonas@weber-gmbh.de', inDays: 5, Guests: 30, 'Assigned To': 'Dana', Priority: 'Urgent' },
  enq_2003: { Name: 'Ben Okafor', Email: 'ben@northwind.io', inDays: 60, Guests: 180, 'Assigned To': 'Lucia', Priority: 'High' },
  enq_2004: { Name: 'Mei Chen', Email: 'mei@lanternhq.com', inDays: 9, Guests: 220, 'Assigned To': 'Dana', Priority: 'Urgent' },
};

const asEvent = (body) => ({ external: 'webhook', event: { arrivals: [{ edge: 'Requests', identity: body.enquiry_id, landing: { recordType: 'Request', fields: body } }] } });

module.exports = { DAY, dayFrom, example, deliveries, EXPECTED, asEvent };

if (require.main === module) {
  const [out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const body = example();
  fs.writeFileSync(path.join(out, 'example.body.json'), `${JSON.stringify(body, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'example.json'), JSON.stringify(asEvent(body)));
}
