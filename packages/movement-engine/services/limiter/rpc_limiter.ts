// A limiter a limiter module serves: the limiter slot's methods
// (docs/contracts/limiter-slot.md) carried as adapter protocol 2 calls over
// HTTP (a Unix socket on this box). How the contract suite (contract.ts)
// holds lf's limiter (`lf --contract-limiter`), and a limiter module lf
// drives, to the meaning every limiter has.

import { z } from 'zod';
import { SlotClient, startModule, type SlotAddress } from '../module_wire/wire';
import type { LimitGrant, Limiter, LimitRequest } from './limiter';

const Grant: z.ZodType<LimitGrant> = z.union([
  z.object({ granted: z.literal(true), permit: z.string() }),
  z.object({ granted: z.literal(false), retryAt: z.string() }),
]);
const Nothing = z.null();

export class RpcLimiter implements Limiter {
  private readonly started: Promise<{ client: SlotClient; close(): Promise<void> }>;

  /** The limiter module `command` starts, or the one already at `address`. */
  constructor(command: string, args: readonly string[]);
  constructor(address: SlotAddress);
  constructor(target: string | SlotAddress, args: readonly string[] = []) {
    this.started =
      typeof target === 'string'
        ? startModule(target, args).then((module) => ({ client: new SlotClient(module.address), close: () => module.close() }))
        : Promise.resolve({ client: new SlotClient(target), close: async () => undefined });
    this.started.catch(() => undefined);
  }

  private async call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    return (await this.started).client.read(method, params, schema);
  }

  async open(settings: Record<string, string> = {}): Promise<void> {
    await this.call('limiter.open', { settings }, Nothing);
  }

  acquire(request: LimitRequest): Promise<LimitGrant> {
    return this.call('limiter.acquire', request, Grant);
  }

  async release(permit: string): Promise<void> {
    await this.call('limiter.release', { permit }, Nothing);
  }

  async throttle(input: { key: string; until: string }): Promise<void> {
    await this.call('limiter.throttle', input, Nothing);
  }

  async close(): Promise<void> {
    await (await this.started.catch(() => undefined))?.close();
  }
}
