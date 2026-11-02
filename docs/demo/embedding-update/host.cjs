// node host.cjs <listen-fire checkout> <product dir> <tenant.json> <keys.json> <slack url>
// Starts the demo product (host/*.ts, copied by capture.sh to <product dir>,
// beside a node_modules that is the checkout's examples/embed-saas one, so it
// runs on the checkout's packages) for one customer: its fields and API key,
// and its Slack. Prints `listening <port>`, and, each with `at <ms>` on this
// process's clock, so capture.sh can time the automation's write against the
// person's change:
//   request <method> <url>              each HTTP request as it arrives
//   arrival <edge> <fields json>        each arrival the product reports to the embedded host
//   program saved <json>                each movement saved: its name and the plan of each listen
//   company write <by> <id> <fields>    each change to a company, by a person or an automation
//   model call <method>                 each call that reaches the models slot (none is expected)
const fs = require('fs');
const path = require('path');

const [src, productDir, tenantFile, keysFile, slackUrl] = process.argv.slice(2).map((arg, i) => (i < 4 ? path.resolve(arg) : arg));
require(require.resolve('tsx/cjs', { paths: [path.join(src, 'examples', 'embed-saas')] }));
const { Product } = require(path.join(productDir, 'product'));
const { productServer } = require(path.join(productDir, 'server'));

const at = () => (performance.timeOrigin + performance.now()).toFixed(2);
const say = (line) => process.stdout.write(`${line} at ${at()}\n`);

async function main() {
  const { tenant, fields } = JSON.parse(fs.readFileSync(tenantFile, 'utf8'));
  const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'))[tenant];
  // No model is expected: the automation makes no ai or extract call. A call
  // that did reach the slot would be printed, then refused.
  const product = new Product({
    models: {
      call: async () => {
        say('model call call');
        throw new Error('this demo has no model');
      },
    },
  });
  const update = product.companies.update.bind(product.companies);
  product.companies.update = (t, id, changed, by) => {
    say(`company write ${by} ${id} ${JSON.stringify(changed)}`);
    return update(t, id, changed, by);
  };
  const fire = product.fire.bind(product);
  product.fire = (t, arrival) => {
    say(`arrival ${arrival.edge} ${JSON.stringify(arrival.landing.fields)}`);
    return fire(t, arrival);
  };
  const write = product.kept.programs.write.bind(product.kept.programs);
  product.kept.programs.write = (t, saved) => {
    say(`program saved ${JSON.stringify({ name: saved.name, listens: saved.listens })}`);
    return write(t, saved);
  };
  await product.addCustomer(tenant, keys.crm, fields);
  await product.connectSlack(tenant, { accessToken: keys.slack, baseUrl: `${slackUrl}/slack/` });
  const server = productServer(product);
  server.prependListener('request', (req) => say(`request ${req.method} ${req.url}`));
  server.listen(0, '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
