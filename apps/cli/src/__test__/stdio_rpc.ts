// A test bridge another process serves over its stdin and stdout, one
// JSON-RPC 2.0 message per line: how `lf --contract-secrets` and
// `lf --contract-doors` arrange and read their test worlds. (Core slot
// modules are not spoken to this way: they speak adapter protocol 2 over
// HTTP, movement-engine `public/module-wire`.)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

const Reply = z.union([
  z.object({ id: z.number().nullable(), error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({ id: z.number(), result: z.unknown() }),
]);

export class StdioRpcBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private exited: Error | undefined;

  constructor(command: string, args: readonly string[]) {
    this.child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    this.child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.on('exit', (code) => {
      this.exited = new Error(`the bridge process exited (${code})${stderr.length > 0 ? `: ${stderr.join('').trim()}` : ''}`);
      for (const waiter of this.waiting.values()) waiter.reject(this.exited);
      this.waiting.clear();
    });
  }

  async call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    if (this.exited !== undefined) throw this.exited;
    const id = this.nextId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new Error(`${method} answered ${JSON.stringify(result)}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  private receive(line: string): void {
    const reply = Reply.safeParse(JSON.parse(line));
    if (!reply.success || reply.data.id === null) return;
    const waiter = this.waiting.get(reply.data.id);
    if (waiter === undefined) return;
    this.waiting.delete(reply.data.id);
    if ('error' in reply.data) waiter.reject(new Error(reply.data.error.message));
    else waiter.resolve(reply.data.result ?? null);
  }

  /** End the process: its stdin closes, and it exits once it has answered. */
  async close(): Promise<void> {
    if (this.exited !== undefined) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin.end();
    await exited;
  }
}
