// node stripe_api.cjs <api key> <reads log> <event dir>…
// Stripe's API as the listen-fire option's @lf/stripe reads it: listen-fire's
// own fake Stripe (modules/stripe/__test__/fake_stripe.ts, from LF_SRC),
// seeded with the stand-in world's customers and subscriptions
// (programs/customers.cjs) and the invoices the event dirs' events carry, so a
// program that walks on from an event (an invoice's Customer or Subscription)
// reads what Stripe would answer. The comparison's world (make_events.cjs
// plain): every customer's Stripe email is the CRM's, and no subscription
// carries metadata. Each read is appended to <reads log> as one JSON line.
// Prints `listening <port>` once it serves.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { customers } = require('./programs/customers.cjs');

const [apiKey, readsLog, ...eventDirs] = process.argv.slice(2);
const LF_SRC = process.env.LF_SRC || path.join(__dirname, '../../../../listen-fire');
createRequire(path.join(LF_SRC, 'packages/module-kit/package.json'))('tsx/cjs');
const { startFakeStripe } = require(path.join(LF_SRC, 'modules/stripe/__test__/fake_stripe.ts'));
const { stripeCustomer, stripeSubscription } = require(path.join(LF_SRC, 'modules/stripe/__test__/fixtures.ts'));

const CREATED = 1727740800; // 2024-10-01, before any invoice

async function main() {
  const stripe = await startFakeStripe({ apiKey });
  for (const c of customers) {
    const s = c.stripe;
    stripe.customer(stripeCustomer({ id: s.id, email: c.crm.email, name: s.name, livemode: true, created: CREATED, invoice_prefix: s.id.slice(4, 12).toUpperCase() }));
    const sub = stripeSubscription({ id: s.subscription, customer: s.id, livemode: true, created: CREATED, start_date: CREATED, billing_cycle_anchor: CREATED, status: 'past_due', metadata: {}, latest_invoice: null });
    const item = sub.items.data[0];
    item.price = { ...item.price, recurring: { interval: s.plan === 'monthly' ? 'month' : 'year', interval_count: 1 }, unit_amount: s.amountCents };
    sub.items.url = `/v1/subscription_items?subscription=${s.subscription}`;
    stripe.subscription(sub);
  }
  for (const dir of eventDirs) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const event = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      stripe.invoice({ ...event.data.object, created: CREATED + Number(f.slice(0, 2)) });
    }
  }
  let logged = 0;
  setInterval(() => {
    const fresh = stripe.requests.slice(logged);
    logged += fresh.length;
    for (const r of fresh) fs.appendFileSync(readsLog, `${JSON.stringify({ at: new Date().toISOString(), method: r.method, path: r.path })}\n`);
  }, 200);
  console.log(`listening ${new URL(stripe.url).port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
