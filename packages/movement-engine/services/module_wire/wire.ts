// The Node side of the one transport every module kind is reached over
// (adapter protocol 2's HTTP; the shapes are engine-contracts `slots/wire`):
// a client that calls a module at any address (`unix:<socket>`, `http://…`,
// `https://…`), a server any test module or embedder can serve a slot from,
// and starting a module process and reading the `listening …` line it prints.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { z } from 'zod';

import { PROTOCOL_VERSION } from 'engine-contracts';
import { SlotAnswerEnvelope, SlotRequestEnvelope, type WireSlotManifestShape } from 'engine-contracts/slots';

/** A module answered `ok: false`. */
export class SlotRefused extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${code} — ${message}`);
    this.name = 'SlotRefused';
  }
}

/** Nothing answered, or not with the protocol's envelope. */
export class SlotTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotTransportError';
  }
}

export interface SlotAddress {
  /** `unix:<path>`, `http://…` or `https://…`. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra headers (the install's outgoing auth: a platform's identity token). */
  headers?: Record<string, string>;
}

/** One POST to a module, its body answered whatever its status. */
export function postTo(address: SlotAddress, body: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...(address.token !== undefined ? { authorization: `Bearer ${address.token}` } : {}),
    ...address.headers,
  };
  return new Promise((resolve, reject) => {
    const answered = (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    };
    const sent = address.baseUrl.startsWith('unix:')
      ? httpRequest({ socketPath: address.baseUrl.slice('unix:'.length), path: '/', method: 'POST', headers }, answered)
      : (address.baseUrl.startsWith('https:') ? httpsRequest : httpRequest)(new URL(address.baseUrl), { method: 'POST', headers }, answered);
    sent.on('error', (error) => reject(new SlotTransportError(`${address.baseUrl} could not be reached: ${error.message}`)));
    sent.end(body);
  });
}

/** A client of one module: `call(method, params)` answers its result, or
 *  throws `SlotRefused` with the module's code. */
export class SlotClient {
  constructor(
    readonly address: SlotAddress,
    readonly settings: Record<string, string> = {},
  ) {}

  async call(method: string, params: object = {}): Promise<unknown> {
    const body = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, method, cacheScopeId: '<slot>', params, settings: this.settings });
    const answer = await postTo(this.address, body);
    if (answer.status < 200 || answer.status >= 300) throw new SlotTransportError(`${method}: HTTP ${answer.status}`);
    let json: unknown;
    try {
      json = JSON.parse(answer.body);
    } catch {
      throw new SlotTransportError(`${method}: the answer is not JSON`);
    }
    const envelope = SlotAnswerEnvelope.safeParse(json);
    if (!envelope.success) throw new SlotTransportError(`${method}: the answer is not the protocol's envelope: ${answer.body.slice(0, 200)}`);
    if (!envelope.data.ok) throw new SlotRefused(method, envelope.data.error.code, envelope.data.error.message, envelope.data.error.data);
    return envelope.data.result ?? null;
  }

  /** `call`, its result read by `schema`. */
  async read<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    const result = await this.call(method, params);
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new Error(`${method} answered ${JSON.stringify(result)}: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }
}

// ── Starting a module ───────────────────────────────────────────────────────

/** The base URL a `listening …` line names: `listening unix:<path>` or
 *  `listening <port>` (loopback TCP). */
export function listeningAddress(line: string): string | undefined {
  const rest = line.startsWith('listening ') ? line.slice('listening '.length).trim() : undefined;
  if (rest === undefined) return undefined;
  if (rest.startsWith('unix:')) return rest.length > 'unix:'.length ? rest : undefined;
  const port = /^\d+/.exec(rest)?.[0];
  return port === undefined ? undefined : `http://127.0.0.1:${port}/`;
}

/** A fresh, short socket path (socket paths are limited to about 100 bytes). */
export function freshSocketPath(): string | undefined {
  if (process.platform === 'win32') return undefined;
  const path = join(tmpdir(), `lf-${randomBytes(6).toString('hex')}.sock`);
  return path.length < 100 ? path : undefined;
}

export interface StartedModule {
  address: SlotAddress;
  child: ChildProcess;
  close(): Promise<void>;
}

/** Start `command` as a module: told where to listen (`MODULE_SOCKET`, else
 *  `PORT=0`) and which token to require (`MODULE_TOKEN`), then read where it
 *  listens off its stdout. */
export function startModule(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}): Promise<StartedModule> {
  const socket = freshSocketPath();
  const token = randomBytes(24).toString('hex');
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, PORT: '0', MODULE_TOKEN: token, ...(socket !== undefined ? { MODULE_SOCKET: socket } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not print "listening …" within ${options.timeoutMs ?? 30_000}ms${stderr.length > 0 ? `: ${stderr.join('').trim()}` : ''}`));
    }, options.timeoutMs ?? 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${command} exited (${code}) before it listened${stderr.length > 0 ? `: ${stderr.join('').trim()}` : ''}`));
    });
    let heard = false;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const baseUrl = heard ? undefined : listeningAddress(line);
      if (baseUrl === undefined) return;
      heard = true;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve({
        address: { baseUrl, token },
        child,
        close: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            child.once('exit', () => done());
            child.kill();
          }).then(() => {
            // A process it left behind may hold the pipes open; this side lets go.
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (socket !== undefined) {
              try {
                unlinkSync(socket);
              } catch {
                // It removed its own.
              }
            }
          }),
      });
    });
  });
}

// ── Serving a slot ──────────────────────────────────────────────────────────

export type SlotAnswer = (method: string, params: Record<string, unknown>, settings: Record<string, unknown>) => Promise<unknown>;

/** Throw from an answer to refuse with a code of the module's own. */
export class SlotRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ServedSlot {
  address: SlotAddress;
  close(): Promise<void>;
}

/** Serve `answer` as a module of `manifest`'s slot. `listen`: a socket path
 *  or a port; default `MODULE_SOCKET`, else `PORT`, else a fresh socket.
 *  `MODULE_TOKEN` (or `token`) is required on every request when set. */
export function serveSlot(options: { manifest: WireSlotManifestShape; answer: SlotAnswer; listen?: string | number; token?: string; print?: boolean }): Promise<ServedSlot> {
  const token = options.token ?? (process.env.MODULE_TOKEN || undefined);
  const server = createServer((request, response) => void handle(request, response));
  const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (token !== undefined && request.headers.authorization !== `Bearer ${token}`) return reply(response, 401, { error: 'unauthorized' });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(response, 400, { error: 'bad_request' });
    }
    const envelope = SlotRequestEnvelope.safeParse(json);
    if (!envelope.success) {
      const version = json !== null && typeof json === 'object' ? Reflect.get(json, 'protocolVersion') : undefined;
      if (version !== undefined && version !== PROTOCOL_VERSION) {
        return reply(response, 200, { ok: false, error: { code: 'protocol_version', message: `this module speaks protocol ${PROTOCOL_VERSION}`, retryable: false } });
      }
      return reply(response, 400, { error: 'bad_request' });
    }
    const { method, params, settings } = envelope.data;
    try {
      const result = method === 'manifest' ? options.manifest : await options.answer(method, params, settings ?? {});
      reply(response, 200, { ok: true, result: result ?? null });
    } catch (error) {
      const refusal = error instanceof SlotRefusal ? error : undefined;
      reply(response, 200, {
        ok: false,
        error: {
          code: refusal?.code ?? 'module_error',
          message: error instanceof Error ? error.message : String(error),
          retryable: refusal === undefined,
          ...(refusal?.data !== undefined ? { data: refusal.data } : {}),
        },
      });
    }
  };
  const fromEnv = (process.env.MODULE_SOCKET || undefined) ?? (process.env.PORT ? Number(process.env.PORT) : undefined);
  const listen = options.listen ?? fromEnv ?? freshSocketPath() ?? 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const ready = () => {
      const bound = server.address();
      const baseUrl = typeof listen === 'string' ? `unix:${listen}` : `http://127.0.0.1:${typeof bound === 'object' && bound !== null ? bound.port : listen}/`;
      if (options.print === true) process.stdout.write(`listening ${typeof listen === 'string' ? `unix:${listen}` : new URL(baseUrl).port}\n`);
      resolve({
        address: { baseUrl, ...(token !== undefined ? { token } : {}) },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    };
    if (typeof listen === 'string') {
      try {
        unlinkSync(listen);
      } catch {
        // No stale socket.
      }
      server.listen(listen, ready);
    } else {
      server.listen(listen, '127.0.0.1', ready);
    }
  });
}
