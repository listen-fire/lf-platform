// `serve-module`: any module as a protocol-2 process, so lf, the Rust host,
// the cloud and an embedder run a module one way. It prints
// `listening <port>` once it answers (the line lf's externals wait for), logs
// as JSON lines on stderr, and binds loopback unless told otherwise. One
// process may serve several modules, each under its own path (lf's shared
// host for trusted modules); an untrusted module gets a process of its own.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';

import { moduleSlug, type ModuleDefinition, type ModuleLog, type ModuleModels, type ModuleSpend } from './define';
import { hostModels } from './host_models';

import { fileKv } from './file_kv';
import { refusingFiles, refusingKv, refusingModels } from './in_process';
import { createModuleProtocolHandler } from './module_server';
import { emptyBrowserSlot, type BrowserSlot } from 'movement-engine/public/browser';

/** A log that writes one JSON line per entry to `write`. */
export function jsonLineLog(module: string, write: (line: string) => void): ModuleLog {
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void =>
      write(`${JSON.stringify({ level, module, message, ...(meta !== undefined ? { meta } : {}) })}\n`);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** The host part of this server's own URL: a wildcard bind is reached at
 *  loopback (a caller elsewhere needs MODULE_PUBLIC_URL). */
function ownOrigin(bindHost: string): string {
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') return '127.0.0.1';
  return bindHost.includes(':') ? `[${bindHost}]` : bindHost;
}

export interface ServeModuleOptions {
  definition: ModuleDefinition;
  /** 0 (the default) picks a free one. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  baseUrlOverride?: string;
  log?: ModuleLog;
  /** Where the module's kv is kept, one file per tenant. Absent: the module
   *  has no kv, and using it is refused. */
  stateDir?: string;
  /** The install's construction arguments, for every request. */
  constructionArgs?: Readonly<Record<string, string>>;
  /** Where callers reach this server (behind a proxy), for file URLs.
   *  Default: the address it binds. */
  publicUrl?: string;
  /** Models to lend the module (an embedder's), or the host's models door
   *  (`hostModels`). Absent: a module call that asks one is refused by name. */
  models?: ModuleModels | ((spend: ModuleSpend) => ModuleModels);
  /** A browser to lend the module (an embedder's). Absent: the browser slot
   *  is empty, and a module call that opens a page is refused by name. */
  browser?: BrowserSlot;
}

export async function serveModule(options: ServeModuleOptions): Promise<{ port: number; server: Server }> {
  const { port, host, ...module } = options;
  return serveModules({ mounts: [{ path: '', options: module }], ...(port !== undefined ? { port } : {}), ...(host !== undefined ? { host } : {}) });
}

/** One module of a shared host: served under `/<path>/`, or at the root
 *  when `path` is empty. */
export interface ModuleMount {
  path: string;
  options: Omit<ServeModuleOptions, 'port' | 'host'>;
}

const MOUNT_PATH = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Several modules in one process (lf's shared host for trusted modules),
 *  each under its own path, each with its own options, log and token. A
 *  module's file URLs are under its own path. */
export async function serveModules(options: { mounts: readonly ModuleMount[]; port?: number; host?: string }): Promise<{ port: number; server: Server }> {
  const { mounts } = options;
  if (mounts.length === 0) throw new Error('serve-module: no module to serve');
  const paths = new Set<string>();
  for (const { path } of mounts) {
    if (path === '' ? mounts.length > 1 : !MOUNT_PATH.test(path)) {
      throw new Error(`serve-module: mount path "${path}" is not a path segment (letters, digits, _ . -), or a root mount is not alone`);
    }
    if (paths.has(path)) throw new Error(`serve-module: two modules are mounted at "${path}"`);
    paths.add(path);
  }
  const routes = new Map<string, Route>();
  const server = createServer((req, res) => {
    const route = routeOf(req, routes);
    if (route === undefined) {
      res.writeHead(routes.size === 0 ? 503 : 404).end();
      return;
    }
    route.handler(req, res).catch((error: unknown) => {
      route.log.error('request failed outside the envelope', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const bindHost = options.host ?? '127.0.0.1';
  await new Promise<void>((done) => server.listen(options.port ?? 0, bindHost, done));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') throw new Error('serve-module: the server is not listening on a port');
  // The handlers are built once the port is known: a file's URL is under
  // the module's public URL, else this server's own bound address, and
  // never under a request's Host header.
  const origin = `http://${ownOrigin(bindHost)}:${address.port}`;
  for (const mount of mounts) {
    const log = mount.options.log ?? jsonLineLog(mount.options.definition.name, (line) => process.stderr.write(line));
    const publicUrl = mount.options.publicUrl ?? (mount.path === '' ? origin : `${origin}/${mount.path}`);
    routes.set(mount.path, { handler: moduleHandler(mount.options, log, publicUrl), log });
  }
  return { port: address.port, server };
}

interface Route {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  log: ModuleLog;
}

/** The mount a request is for, its URL made relative to the mount. */
function routeOf(req: IncomingMessage, routes: ReadonlyMap<string, Route>): Route | undefined {
  const root = routes.get('');
  if (root !== undefined) return root;
  const url = req.url ?? '/';
  const segment = url.slice(1).split(/[/?]/, 1)[0] ?? '';
  const route = routes.get(segment);
  if (route === undefined) return undefined;
  const rest = url.slice(segment.length + 1);
  req.url = rest.startsWith('/') ? rest : `/${rest}`;
  return route;
}

function moduleHandler(options: Omit<ServeModuleOptions, 'port' | 'host'>, log: ModuleLog, publicUrl: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { definition, token, stateDir } = options;
  const unavailable = (what: string) =>
    `module ${definition.name}: ${what} is not available when the module is served as a process (protocol 2 carries files by URL and keeps no module state)`;
  const noKv = refusingKv(`${unavailable('ctx.kv')}; set MODULE_STATE_DIR to keep it in files`);
  return createModuleProtocolHandler({
    definition,
    log,
    files: refusingFiles(unavailable('ctx.files')),
    kvFor: stateDir !== undefined ? (tenant) => fileKv(stateDir, tenant) : () => noKv,
    models: options.models ?? refusingModels(`module ${definition.name}: ctx.models is lent by no host when the module is served by the serve-module command line`),
    browser:
      options.browser ??
      emptyBrowserSlot(`module ${definition.name} is served by the serve-module command line, which lends no browser (the platform's api image fills the slot with Chromium)`),
    ...(options.baseUrlOverride !== undefined ? { baseUrlOverride: options.baseUrlOverride } : {}),
    ...(options.constructionArgs !== undefined ? { constructionArgs: options.constructionArgs } : {}),
    publicUrl,
    ...(token !== undefined ? { authenticate: (headers) => headers.authorization === `Bearer ${token}` } : {}),
  });
}

/** Whether a loaded value is a module definition (its default export, or
 *  `module`). Checked by shape: the file is the operator's, not ours. */
export function isModuleDefinition(value: unknown): value is ModuleDefinition {
  if (value === null || typeof value !== 'object') return false;
  const kind: unknown = Reflect.get(value, 'kind');
  return (
    (kind === 'adapter' || kind === 'plugin') &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'create') === 'function' &&
    Array.isArray(Reflect.get(value, 'credentials'))
  );
}

/** Load the module a path or package name names, relative to `cwd`. */
export function loadModuleDefinition(specifier: string, cwd: string): ModuleDefinition {
  const target = specifier.startsWith('.') || specifier.startsWith('/') ? resolvePath(cwd, specifier) : specifier;
  const loaded: unknown = require(require.resolve(target, { paths: [cwd] }));
  for (const candidate of [loaded, Reflect.get(Object(loaded), 'default'), Reflect.get(Object(loaded), 'module')]) {
    if (isModuleDefinition(candidate)) return candidate;
  }
  throw new Error(`serve-module: ${specifier} exports no module (a default export or \`module\` made with defineModule)`);
}

/** A JSON object of strings (`MODULE_CONSTRUCTION_ARGS`), or a refusal. */
export function parseConstructionArgs(text: string): Record<string, string> {
  const refuse = (): never => {
    throw new Error('serve-module: MODULE_CONSTRUCTION_ARGS is a JSON object of strings, e.g. {"spreadsheet":"Pipeline"}');
  };
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse();
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) args[name] = typeof value === 'string' ? value : refuse();
  return args;
}

/** A module's options from its environment: MODULE_TOKEN,
 *  MODULE_BASE_URL_OVERRIDE, MODULE_STATE_DIR, MODULE_CONSTRUCTION_ARGS,
 *  MODULE_PUBLIC_URL, and the host's models door (LF_HOST_URL,
 *  LF_HOST_TOKEN). */
function moduleOptionsOf(definition: ModuleDefinition, env: Readonly<Record<string, string | undefined>>): Omit<ServeModuleOptions, 'port' | 'host'> {
  const set = (name: string): string | undefined => (env[name] !== undefined && env[name] !== '' ? env[name] : undefined);
  const token = set('MODULE_TOKEN');
  const baseUrlOverride = set('MODULE_BASE_URL_OVERRIDE');
  const stateDir = set('MODULE_STATE_DIR');
  const constructionArgs = set('MODULE_CONSTRUCTION_ARGS');
  const publicUrl = set('MODULE_PUBLIC_URL');
  const hostUrl = set('LF_HOST_URL');
  const hostToken = set('LF_HOST_TOKEN');
  return {
    definition,
    ...(token !== undefined ? { token } : {}),
    ...(baseUrlOverride !== undefined ? { baseUrlOverride } : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(constructionArgs !== undefined ? { constructionArgs: parseConstructionArgs(constructionArgs) } : {}),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    // A host that serves the models door names itself (LF_HOST_URL) and the
    // token its doors take from this process (LF_HOST_TOKEN).
    ...(hostUrl !== undefined
      ? {
          models: hostModels({
            url: `${hostUrl.replace(/\/$/, '')}/api/public/adapter/${moduleSlug(definition.name)}/models`,
            headers: hostToken !== undefined ? { authorization: `Bearer ${hostToken}` } : {},
          }),
        }
      : {}),
  };
}

/** `MODULE_MOUNTS`: a JSON array of `{ path, module, cwd?, env? }` — each
 *  module's own MODULE_* settings in `env`, over the process's. */
export function parseMounts(text: string): { path: string; module: string; cwd?: string; env: Record<string, string> }[] {
  const refuse = (): never => {
    throw new Error('serve-module: MODULE_MOUNTS is a JSON array of { path, module, cwd?, env? }, e.g. [{"path":"attio","module":"@lf/attio"}]');
  };
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return refuse();
  return parsed.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return refuse();
    const path: unknown = Reflect.get(entry, 'path');
    const module: unknown = Reflect.get(entry, 'module');
    const cwd: unknown = Reflect.get(entry, 'cwd');
    const env: unknown = Reflect.get(entry, 'env') ?? {};
    if (typeof path !== 'string' || typeof module !== 'string' || (cwd !== undefined && typeof cwd !== 'string')) return refuse();
    if (env === null || typeof env !== 'object' || Array.isArray(env)) return refuse();
    const strings: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) strings[name] = typeof value === 'string' ? value : refuse();
    return { path, module, ...(cwd !== undefined ? { cwd } : {}), env: strings };
  });
}

/** With LF_EXIT_WITH_PARENT set, the process ends when its parent does:
 *  the parent holds this process's stdin, so its end closing is the
 *  parent gone (through any shim in between); being re-parented to init
 *  is the same news on a parent that gave no stdin. */
function exitWithParent(env: Readonly<Record<string, string | undefined>>): void {
  if (env.LF_EXIT_WITH_PARENT === undefined || env.LF_EXIT_WITH_PARENT === '') return;
  const gone = (): never => process.exit(0);
  process.stdin.on('end', gone).on('close', gone).on('error', gone).resume();
  setInterval(() => {
    if (process.ppid === 1) gone();
  }, 1000).unref();
}

/** The command line: `serve-module <module> [--port N] [--host H]`, or
 *  `serve-module` with MODULE_MOUNTS for several modules in one process;
 *  PORT and each module's settings (moduleOptionsOf) from the environment. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<void> {
  const args = [...argv];
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const [, value] = args.splice(at, 2);
    return value;
  };
  const port = flag('--port') ?? env.PORT;
  const host = flag('--host');
  const [specifier] = args;
  const mounted = env.MODULE_MOUNTS !== undefined && env.MODULE_MOUNTS !== '' ? parseMounts(env.MODULE_MOUNTS) : undefined;
  if (specifier === undefined && mounted === undefined) throw new Error('usage: serve-module <module> [--port N] [--host H], or MODULE_MOUNTS for several');
  if (specifier !== undefined && mounted !== undefined) throw new Error('serve-module: name one module or set MODULE_MOUNTS, not both');
  exitWithParent(env);
  const mounts: ModuleMount[] =
    mounted !== undefined
      ? mounted.map((mount) => ({
          path: mount.path,
          options: moduleOptionsOf(loadModuleDefinition(mount.module, mount.cwd ?? process.cwd()), { ...env, ...mount.env }),
        }))
      : [{ path: '', options: moduleOptionsOf(loadModuleDefinition(specifier ?? '', process.cwd()), env) }];
  const served = await serveModules({ mounts, ...(port !== undefined ? { port: Number(port) } : {}), ...(host !== undefined ? { host } : {}) });
  process.stdout.write(`listening ${served.port}\n`);
}
