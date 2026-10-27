// node change.cjs <base url> <method> <path> <fields json>
// A person's change in the product, through its own route: POST creates a
// company, PATCH changes one. The product dispatches the event it raises to
// every listening movement, in its process, before it answers. Prints
// { ms, status, body }: ms runs from just before the request to its response.
const [base, method, route, fields] = process.argv.slice(2);

async function main() {
  const started = performance.now();
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: fields });
  const body = await response.json();
  const ms = Math.round(performance.now() - started);
  process.stdout.write(`${JSON.stringify({ ms, status: response.status, body })}\n`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
