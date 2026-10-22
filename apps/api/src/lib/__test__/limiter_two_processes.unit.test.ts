// Two api processes on one database share the limiter installed at boot:
// @lf/anthropic's 8 requests in flight is 8 across both, and a vendor's
// Retry-After met by one holds the other's next request until then. Each
// process is a real child (limiter_process.ts) calling through the anthropic
// module's own client, at a fake Messages server here that counts what is in
// flight.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';

import Pg from 'pg';

const REPLY = '@limiter-process ';
const HOLD_RESPONSE_MS = 250;
const RETRY_AFTER_SECONDS = 7;

const databaseUrl = process.env.DATABASE_URL_TEST ?? '';
const schema = `lf_limiter_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

interface Arrival {
  process: string;
  at: number;
  status: number;
}

/** The Messages API, as far as a structured call reads it. */
function fakeMessagesServer() {
  const arrivals: Arrival[] = [];
  const rateLimitNext = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    const name = String(req.headers['x-api-key'] ?? '');
    req.resume();
    req.on('end', () => {
      if (rateLimitNext.delete(name)) {
        arrivals.push({ process: name, at: Date.now(), status: 429 });
        // The SDK honours `x-should-retry: false` and hands the 429 straight to
        // the module, whose own handling (the throttle) is what is under test.
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(RETRY_AFTER_SECONDS),
          'x-should-retry': 'false',
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
        return;
      }
      arrivals.push({ process: name, at: Date.now(), status: 200 });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_${randomUUID()}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-fake',
            content: [{ type: 'tool_use', id: `toolu_${randomUUID()}`, name: 'answer', input: { ok: true } }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }, HOLD_RESPONSE_MS);
    });
  });
  return {
    server,
    arrivals,
    rateLimitNext,
    maxInFlight: () => maxInFlight,
    resetMax: () => {
      maxInFlight = 0;
    },
  };
}

interface ApiProcess {
  /** Fire `calls` model calls at once; resolves with the process's answer. */
  fire(calls: number): Promise<{ answered: number; startedAt: number; finishedAt: number }>;
  stop(): void;
}

async function startApiProcess(name: string, fakeUrl: string): Promise<ApiProcess> {
  const apiDir = path.resolve(__dirname, '..', '..', '..');
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', path.join(__dirname, 'limiter_process.ts')],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        TS_NODE_PROJECT: path.join(apiDir, 'tsconfig.dev.json'),
        DATABASE_URL: databaseUrl,
        LIMITER_SCHEMA: schema,
        FAKE_ANTHROPIC_URL: fakeUrl,
        PROCESS_NAME: name,
      },
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const waiting: Array<(message: Record<string, unknown>) => void> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith(REPLY)) waiting.shift()?.(JSON.parse(line.slice(REPLY.length)));
  });
  const next = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      waiting.push(resolve);
      child.once('exit', (code) => reject(new Error(`process ${name} exited (${code}): ${stderr}`)));
    });
  await next();
  return {
    fire: async (calls) => {
      const answer = next();
      child.stdin.write(`${calls}\n`);
      const { answered, startedAt, finishedAt } = await answer;
      return { answered: Number(answered), startedAt: Number(startedAt), finishedAt: Number(finishedAt) };
    },
    stop: () => {
      child.kill();
    },
  };
}

const fake = fakeMessagesServer();
const processes: ApiProcess[] = [];
let a: ApiProcess;
let b: ApiProcess;

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake Messages server has no port');
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

it('holds the model requests in flight to 8 across both processes', async () => {
  fake.resetMax();
  const [fromA, fromB] = await Promise.all([a.fire(12), b.fire(12)]);

  expect(fromA.answered + fromB.answered).toBe(24);
  // Each process alone would allow 8, so 16 at once without the shared count.
  expect(fake.maxInFlight()).toBeLessThanOrEqual(8);
  expect(fake.maxInFlight()).toBeGreaterThan(1);
}, 60_000);

it("holds the other process's next request until a vendor's Retry-After has passed", async () => {
  fake.arrivals.length = 0;
  fake.rateLimitNext.add('a');
  const fromA = a.fire(1);
  const rateLimitedAt = await new Promise<number>((resolve) => {
    const poll = setInterval(() => {
      const refused = fake.arrivals.find((arrival) => arrival.status === 429);
      if (refused) {
        clearInterval(poll);
        resolve(refused.at);
      }
    }, 10);
  });
  const fromB = await b.fire(1);
  expect((await fromA).answered).toBe(1);
  expect(fromB.answered).toBe(1);

  const sentByB = fake.arrivals.filter((arrival) => arrival.process === 'b');
  expect(sentByB).toHaveLength(1);
  const waitedUntil = rateLimitedAt + RETRY_AFTER_SECONDS * 1000;
  // A little slack for the throttle being set from the moment `a` read the 429.
  expect(sentByB[0]?.at).toBeGreaterThanOrEqual(waitedUntil - 250);
  // `b` asked well inside the wait, so the wait was the limiter's, not its start-up.
  expect(fromB.startedAt).toBeLessThan(rateLimitedAt + 2000);
}, 60_000);
