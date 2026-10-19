// A third-party store module for the tests, served as adapter protocol 2 over
// HTTP on the socket lf names (`MODULE_SOCKET`, else `PORT`): it reads its
// `path` setting from the store slot's opening request (`store.open`), starts
// `lf --contract-store <path>`, which serves the same methods over a SQLite
// state file, and forwards every request, that one included, to it.
// Usage: node forward.mjs <lf binary>.

import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createInterface } from 'node:readline';
import { unlinkSync } from 'node:fs';

const [lf] = process.argv.slice(2);
const token = process.env.MODULE_TOKEN || undefined;
let store; // Promise of the forwarded store's base URL

function startStore(path) {
  const env = { ...process.env };
  delete env.MODULE_SOCKET;
  delete env.MODULE_TOKEN;
  delete env.PORT;
  // It holds the child's stdin, so the child ends with it however it ends.
  const child = spawn(lf, ['--contract-store', path], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, LF_EXIT_WITH_PARENT: '1' } });
  process.on('exit', () => child.kill());
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`lf --contract-store exited (${code})`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      const rest = line.startsWith('listening ') ? line.slice('listening '.length).trim() : '';
      if (rest.startsWith('unix:')) resolve({ socketPath: rest.slice('unix:'.length) });
      else if (/^\d+/.test(rest)) resolve({ host: '127.0.0.1', port: Number(/^\d+/.exec(rest)[0]) });
    });
  });
}

function forward(target, body) {
  return new Promise((resolve, reject) => {
    const sent = request({ ...target, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (answer) => {
      const chunks = [];
      answer.on('data', (chunk) => chunks.push(chunk));
      answer.on('end', () => resolve({ status: answer.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    sent.on('error', reject);
    sent.end(body);
  });
}

const server = createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    return reply(400, { error: 'bad_request' });
  }
  if (store === undefined) {
    const path = envelope.params?.settings?.path;
    if (envelope.method !== 'store.open' || typeof path !== 'string') {
      return reply(200, { ok: false, error: { code: 'bad_request', message: 'open me with store.open { settings: { path } }', retryable: false } });
    }
    store = startStore(path);
  }
  try {
    const answered = await forward(await store, body);
    reply(answered.status, answered.body);
  } catch (error) {
    reply(200, { ok: false, error: { code: 'module_error', message: String(error?.message ?? error), retryable: true } });
  }
});

const socket = process.env.MODULE_SOCKET || undefined;
if (socket !== undefined) {
  try {
    unlinkSync(socket);
  } catch {
    // No stale socket.
  }
  server.listen(socket, () => process.stdout.write(`listening unix:${socket}\n`));
} else {
  server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
}
