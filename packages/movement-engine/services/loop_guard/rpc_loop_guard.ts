// A loop guard a loop guard module serves: the slot's methods
// (docs/contracts/loop-guard-slot.md) carried as adapter protocol 2 calls
// over HTTP (a Unix socket on this box). How the contract suite
// (contract.ts) holds lf's guard (`lf --contract-guard`), and a guard module
// lf drives, to the meaning every guard has.

import { z } from 'zod';
import { SlotClient, startModule, type SlotAddress } from '../module_wire/wire';
import type { EchoAnswer, EchoQuestion, LoopGuard, RecordWrite } from './loop_guard';

const Answer: z.ZodType<EchoAnswer> = z.union([z.object({ echo: z.boolean() }), z.object({ read: z.object({ recordType: z.string() }) })]);
const Nothing = z.null();

export class RpcLoopGuard implements LoopGuard {
  private readonly started: Promise<{ client: SlotClient; close(): Promise<void> }>;

  /** The guard module `command` starts, or the one already at `address`. */
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
    await this.call('guard.open', { settings }, Nothing);
  }

  async recordWrite(write: RecordWrite): Promise<void> {
    await this.call('guard.recordWrite', write, Nothing);
  }

  isEcho(question: EchoQuestion): Promise<EchoAnswer> {
    return this.call('guard.isEcho', question, Answer);
  }

  async close(): Promise<void> {
    await (await this.started.catch(() => undefined))?.close();
  }
}
