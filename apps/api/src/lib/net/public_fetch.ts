// A fetch for URLs a user supplied (an MCP server's address): https to public
// addresses only. Each request is refused before it is sent when its host is,
// or resolves to, an address that is not public, and the connection itself is
// opened only to an address checked at connect time, so a name that resolves
// to a public address for the check and a private one for the request (DNS
// rebinding) is refused too. A redirect is refused rather than followed: the
// connection names its server, and a redirect would name another.
//
// http is reached only for localhost, and only when NODE_ENV is development or
// test: the dev loop's and the tests' fake servers.

import type { LookupFunction } from 'node:net';

import { Agent } from 'undici';

import { NonPublicAddress, POLICY_REFUSAL_CODE, publicAddressesOf, systemLookup, type HostLookup } from './public_address';

/** Development and test reach a server on this machine; nothing else does. */
const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test']);
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

type Environment = Readonly<Record<string, string | undefined>>;

interface PublicFetchOptions {
  /** Default: the process's. */
  env?: Environment;
  /** Default: the system resolver. */
  lookup?: HostLookup;
  /** The fetch that sends a request once it is allowed. Default: the global. */
  fetch?: typeof fetch;
}

/** A refused request: its URL is not one this fetch reaches. The message
 *  follows the caller's name for the URL ("MCP server https://…: "). */
export class RefusedUrl extends Error {
  readonly code = POLICY_REFUSAL_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'RefusedUrl';
  }
}

/** Whether `url` names this machine and the environment lets a request reach it. */
function isAllowedLocal(url: URL, env: Environment): boolean {
  return LOCAL_ENVIRONMENTS.has(env.NODE_ENV ?? '') && LOOPBACK_NAMES.has(url.hostname);
}

/** What is wrong with a parsed URL before any request, in words that follow
 *  its name; undefined when it may be asked (its addresses are still checked
 *  when it is). */
function schemeRefusal(url: URL, env: Environment): string | undefined {
  if (isAllowedLocal(url, env) || url.protocol === 'https:') return undefined;
  return 'must be https (http is reached only for localhost, in development)';
}

/**
 * Why `url` is refused before any request, or undefined: the rule a URL is
 * held to when it is entered, so a URL the platform would refuse to reach is
 * never stored.
 */
export function urlRefusal(url: string, options: { label: string; env?: Environment }): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${options.label} URL "${url}" is not a URL.`;
  }
  const refusal = schemeRefusal(parsed, options.env ?? process.env);
  return refusal === undefined ? undefined : `${options.label} URL "${url}" ${refusal}.`;
}

/** The connect-time half: the resolver the connection uses, refusing any
 *  address that is not public, so what was checked is what is connected to. */
export function publicOnlyLookup(lookup: HostLookup): LookupFunction {
  return (hostname, options, callback) => {
    publicAddressesOf(hostname, lookup).then(
      (addresses) => {
        const [first] = addresses;
        if (options.all === true) callback(null, addresses);
        else if (first === undefined) callback(new NonPublicAddress(hostname), '');
        else callback(null, first.address, first.family);
      },
      (error: Error) => callback(error, ''),
    );
  };
}

const agents = new WeakMap<HostLookup, Agent>();

function agentFor(lookup: HostLookup): Agent {
  const known = agents.get(lookup);
  if (known !== undefined) return known;
  const agent = new Agent({ connect: { lookup: publicOnlyLookup(lookup) } });
  agents.set(lookup, agent);
  return agent;
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

export function publicFetch(options: PublicFetchOptions = {}): typeof fetch {
  const env = options.env ?? process.env;
  const lookup = options.lookup ?? systemLookup;
  const send = options.fetch ?? fetch;
  return async (input, init) => {
    const target = urlOf(input);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new RefusedUrl(`"${target}" is not a URL.`);
    }
    const refusal = schemeRefusal(url, env);
    if (refusal !== undefined) throw new RefusedUrl(`the URL ${refusal}.`);
    let response: Response;
    if (isAllowedLocal(url, env)) {
      response = await send(input, { ...init, redirect: 'manual' });
    } else {
      try {
        await publicAddressesOf(url.hostname, lookup);
      } catch (error) {
        throw new RefusedUrl(error instanceof Error ? error.message : String(error));
      }
      // `dispatcher` is the runtime's (undici's) own option, which the DOM's
      // RequestInit does not list.
      const guarded: RequestInit & { dispatcher: Agent } = { ...init, redirect: 'manual', dispatcher: agentFor(lookup) };
      response = await send(input, guarded);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      throw new RefusedUrl(
        `it answered with a redirect${location !== null ? ` to ${location}` : ''}; redirects are not followed, so connect the URL it redirects to.`,
      );
    }
    return response;
  };
}
