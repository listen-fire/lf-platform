// node make_events.cjs <day> <out dir> [plain]: the fake Stripe's failed payments
// for one day, one `invoice.payment_failed` event per customer of that day in
// programs/customers.cjs, written as <out dir>/<nn>.json in the order they are
// sent. The shape is Stripe's (API version 2024-06-20): the event, the
// invoice as `data.object`, and the subscription's metadata copied onto the
// invoice as `subscription_details.metadata`, which is where Stripe puts it.
// `created` is set when deliver.cjs sends it.
//
// `plain`: every customer's Stripe email is the CRM's, and the subscription
// carries no metadata (the comparison's world, compare.sh).
const fs = require('fs');
const path = require('path');
const { customers, idMaker } = require('./programs/customers.cjs');

const [day, outDir, mode] = process.argv.slice(2);
const plain = mode === 'plain';
const id = idMaker(9000 + Number(day));
const ACCOUNT = 'acct_1PqLdgRl3dGrX9vB';
fs.mkdirSync(outDir, { recursive: true });

// A fixed shuffle, so the customers the CRM cannot find are spread through the day.
const today = customers.filter((c) => c.day === Number(day));
const order = today.map((c, i) => ({ c, key: (i * 7 + Number(day) * 3) % today.length })).sort((a, b) => a.key - b.key).map((x) => x.c);

order.forEach((c, i) => {
  const s = c.stripe;
  const invoice = id('in_1Q', 22);
  const interval = s.plan === 'monthly' ? 'month' : 'year';
  const event = {
    id: id('evt_1Q', 22),
    object: 'event',
    api_version: '2024-06-20',
    created: null,
    livemode: true,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: invoice,
        object: 'invoice',
        account_country: 'GB',
        account_name: 'Ledgerline',
        amount_due: s.amountCents,
        amount_paid: 0,
        amount_remaining: s.amountCents,
        attempt_count: i % 4 === 3 ? 2 : 1,
        attempted: true,
        billing_reason: 'subscription_cycle',
        collection_method: 'charge_automatically',
        currency: 'usd',
        customer: s.id,
        customer_email: plain ? c.crm.email : s.email,
        customer_name: s.name,
        hosted_invoice_url: `https://invoice.stripe.com/i/${ACCOUNT}/${id('live_YWNjdF8x', 40)}`,
        invoice_pdf: null,
        lines: {
          object: 'list',
          data: [{ object: 'line_item', amount: s.amountCents, currency: 'usd', description: `1 × Ledgerline ${s.plan === 'monthly' ? 'Monthly' : 'Yearly'} (at $${s.amountCents / 100}.00 / ${interval})` }],
          has_more: false,
        },
        metadata: {},
        next_payment_attempt: null,
        number: `LL-${String(4100 + Number(day) * 100 + i)}`,
        paid: false,
        payment_intent: id('pi_3Q', 22),
        status: 'open',
        subscription: s.subscription,
        subscription_details: { metadata: plain ? {} : { crm_id: s.crmId } },
        total: s.amountCents,
      },
    },
  };
  fs.writeFileSync(path.join(outDir, `${String(i + 1).padStart(2, '0')}.json`), `${JSON.stringify(event, null, 2)}\n`);
});
console.log(`${order.length} events for day ${day}`);
