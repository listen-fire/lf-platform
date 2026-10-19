// `@lf/ask`: asking a person mid-run, as a module. The module owns what an ask
// IS — its families, the answer each accepts, the open → answered | expired
// lattice, the Response edge a run awaits. The host owns the rest:
//
//   - its kv keeps the records (the platform's is its asks table, so asks
//     raised before ask was a module answer and wake exactly as before);
//   - its answer door (a link page, a chat button) is where a person answers,
//     at the link `answerUrl` names, and it answers through `answerAsk` here;
//   - it wakes a run parked on an ask when the ask settles, by the ask's id —
//     the core's park/await contract, nothing ask-shaped.
//
// Credential-free and constructed with no arguments (`asks = ask()`), like
// `cron` and `manual`; nothing to connect.

import { defineModule, type AdapterModuleDefinition } from 'module-kit';

import { AskAdapter } from './adapter';
import { ASK_MANIFEST } from './manifest';
import type { AnswerUrl } from './records';

export interface AskHost {
  /** The link a person answers an ask at, by its token: the host's answer
   *  door. Absent on a host with no door, which then refuses to raise an ask
   *  (nobody could answer it). */
  answerUrl?: AnswerUrl;
}

/** The module for a host, which says where its answer door is. */
export function askModuleWith(host: AskHost): AdapterModuleDefinition {
  const answerUrl: AnswerUrl =
    host.answerUrl ??
    (() => {
      throw new Error('ask: this host has no answer door, so an ask raised here could never be answered');
    });
  return defineModule({
    kind: 'adapter',
    name: '@lf/ask',
    manifest: ASK_MANIFEST,
    credentials: [],
    create: (ctx) => new AskAdapter({ kv: ctx.kv, answerUrl }),
  });
}

/** The module on a host with no answer door: asks can be described and
 *  checked, but raising one is refused by name. */
export const askModule = askModuleWith({});

export default askModule;

export * from './adapter';
export * from './answers';
export * from './descriptors';
export * from './link';
export * from './manifest';
export * from './records';
export * from './types';
