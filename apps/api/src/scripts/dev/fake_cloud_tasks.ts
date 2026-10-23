/**
 * The dev loop's stand-in Google Cloud Tasks, for the wake shape.
 *
 *   pnpm dev:fake-cloud-tasks
 *
 * Serves the wake module's own fake (`@listen-fire/wake-cloud-tasks/fake_cloud_tasks`)
 * on `FAKE_CLOUD_TASKS_PORT`, and runs each task when it comes due as Cloud
 * Tasks would start the Cloud Run job: by running `pnpm drain:once` in
 * apps/api. The job inherits this process's environment, the `WAKE_*`
 * settings included, so its own re-arms are announced to this fake too.
 *
 * Logs one line per task created, coalesced (its name was already taken) and
 * run, with UTC times. `GET /_fake/tasks` answers the pending, created and run
 * tasks.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

import { fakeCloudTasks, type FakeRun } from '@listen-fire/wake-cloud-tasks/fake_cloud_tasks';

const API_DIR = path.resolve(__dirname, '..', '..', '..');

function log(line: string): void {
  console.log(`[fake-cloud-tasks] ${new Date().toISOString()} ${line}`);
}

/** The job: `pnpm drain:once`, resolving to its exit code. */
function runDrainOnce(): Promise<{ code: number | null; result: string }> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['-s', 'drain:once'], { cwd: API_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, result: error.message }));
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n');
      const result = lines[lines.length - 1] ?? '';
      if (code !== 0) process.stderr.write(stderr.slice(-4_000));
      resolve({ code, result });
    });
  });
}

async function onRun(run: FakeRun): Promise<void> {
  log(`task due ${run.name} ${run.scheduleTime}, starting drain:once (${run.authorization.replace(/^Bearer /, 'token ')})`);
  const { code, result } = await runDrainOnce();
  log(`task ran ${run.name} ${run.scheduleTime} ${code ?? 'no exit code'} ${result}`);
}

/** The fake listens on a port of its own choosing; the module's base_url names
 *  this profile's fixed port, so a front forwards each request to it and
 *  reads each create's answer for the log. */
function front(target: string, port: number): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== 'host'),
      );
      void fetch(`${target}${request.url ?? '/'}`, {
        method: request.method ?? 'GET',
        headers,
        ...(body.length > 0 ? { body } : {}),
      })
        .then(async (answer) => {
          const text = await answer.text();
          if (request.method === 'POST' && /\/tasks$/.test(request.url ?? '')) logCreate(body, answer.status);
          response.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
          response.end(text);
        })
        .catch((error: unknown) => {
          response.writeHead(502);
          response.end(error instanceof Error ? error.message : String(error));
        });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function logCreate(body: Buffer, status: number): void {
  let name = '?';
  let scheduleTime = '?';
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    const task: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'task') : undefined;
    if (typeof task === 'object' && task !== null) {
      name = String(Reflect.get(task, 'name'));
      scheduleTime = String(Reflect.get(task, 'scheduleTime'));
    }
  } catch {
    // An unreadable body is the fake's to refuse; the log says only its status.
  }
  const outcome = status === 200 ? 'created' : status === 409 ? 'coalesced' : `refused ${status}`;
  log(`task ${outcome} ${name} ${scheduleTime}`);
}

async function main(): Promise<void> {
  const port = Number(process.env.FAKE_CLOUD_TASKS_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('FAKE_CLOUD_TASKS_PORT must be a port number');
  const fake = await fakeCloudTasks({ dispatch: 'timer', onRun });
  const server = await front(fake.url, port);
  log(`Cloud Tasks on http://127.0.0.1:${port} (tasks run pnpm drain:once; GET /_fake/tasks)`);
  const stop = () => {
    server.close();
    void fake.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error('[fake-cloud-tasks] failed to start', error);
  process.exit(1);
});
