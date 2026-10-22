// Two api processes on one database share Bright Data's SERP limit: 14 a
// minute is 14 across both, not 14 each. Each process is a real child
// (serp_process.ts) calling the platform's web search at a fake Bright Data
// endpoint here that counts what arrives, and from whom.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';

import Pg from 'pg';

const REPLY = '@serp-process ';
const PER_MINUTE = 14;

const databaseUrl = process.env.DATABASE_URL_TEST ?? '';
const schema = `lf_limiter_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

interface Arrival {
  process: string;
  at: number;
}

/** The SERP zone, as far as a search reads it: an empty organic result. */
function fakeBrightDataServer() {
  const arrivals: Arrival[] = [];
  const server = http.createServer((req, res) => {
    const process = String(req.headers['x-process'] ?? '');
    req.resume();
    req.on('end', () => {
      arrivals.push({ process, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ organic: [] }));
    });
  });
  return { server, arrivals };
}

interface ApiProcess {
  /** Fire `searches` at once; resolves when every one is answered. */
  fire(searches: number): Promise<void>;
  stop(): void;
}

async function startApiProcess(name: string, fakeUrl: string): Promise<ApiProcess> {
  const apiDir = path.resolve(__dirname, '..', '..', '..');
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', path.join(__dirname, 'serp_process.ts')],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        TS_NODE_PROJECT: path.join(apiDir, 'tsconfig.dev.json'),
        DATABASE_URL: databaseUrl,
        LIMITER_SCHEMA: schema,
        FAKE_BRIGHT_DATA_URL: fakeUrl,
        PROCESS_NAME: name,
        WEB_SEARCH_PROVIDER: 'brightdata',
        BRIGHT_DATA_ACCESS_TOKEN: 'token-123',
        BRIGHT_DATA_SERP_ZONE: 'serp_zone',
        BRIGHT_DATA_SERP_PER_MINUTE: String(PER_MINUTE),
      },
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let stopping = false;
  const waiting: Array<() => void> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith(REPLY)) waiting.shift()?.();
  });
  const next = () =>
    new Promise<void>((resolve, reject) => {
      waiting.push(resolve);
      // Searches the limiter is still holding leave a reply pending when the test ends and
      // the child is killed; that exit is the teardown, not a failure.
      child.once('exit', (code) => {
        if (stopping) resolve();
        else reject(new Error(`process ${name} exited (${code}): ${stderr}`));
      });
    });
  await next();
  return {
    fire: async (searches) => {
      const answer = next();
      child.stdin.write(`${searches}\n`);
      await answer;
    },
    stop: () => {
      stopping = true;
      child.kill();
    },
  };
}

const fake = fakeBrightDataServer();
const processes: ApiProcess[] = [];
let a: ApiProcess;
let b: ApiProcess;

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake Bright Data server has no port');
  const url = `http://127.0.0.1:${address.port}`;
  [a, b] = await Promise.all([startApiProcess('a', url), startApiProcess('b', url)]);
  processes.push(a, b);
}, 60_000);

afterAll(async () => {
  for (const each of processes) each.stop();
  await new Promise((resolve) => fake.server.close(resolve));
  const client = new Pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`drop schema if exists "${schema}" cascade`);
  await client.end();
});

it('sends 14 SERP requests a minute across both processes, the rest held waiting', async () => {
  // Each process alone has 14 to spend, so 28 would arrive at once without the shared count.
  void a.fire(PER_MINUTE);
  void b.fire(PER_MINUTE);
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  const split = Object.fromEntries(
    ['a', 'b'].map((name) => [name, fake.arrivals.filter((arrival) => arrival.process === name).length]),
  );
  console.log(`SERP arrivals after 4s: ${fake.arrivals.length}; per process ${JSON.stringify(split)}`);

  // The bucket refills one call every 4.3 seconds, so at most one more has
  // been let through by now.
  expect(fake.arrivals.length).toBeGreaterThanOrEqual(PER_MINUTE);
  expect(fake.arrivals.length).toBeLessThanOrEqual(PER_MINUTE + 1);
  // Both processes drew on the one bucket.
  expect(new Set(fake.arrivals.map((arrival) => arrival.process))).toEqual(new Set(['a', 'b']));
}, 60_000);
