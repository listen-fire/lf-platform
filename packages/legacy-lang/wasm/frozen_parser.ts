// The platform's reader for the language versions the language release no
// longer serves (pins below 5) and for the version-0 expression surface: the
// parser artifact frozen at the last commit that read versions 1–5
// (./movement_parser.frozen.wasm; README.md beside it says how it was built).
// The language's own loader (movement-lang/wasm/loader.ts) serves the live
// artifact; this is the minimal part of it a parse and a lowering need, over
// the frozen one. The frozen artifact lowers the trees it parsed, so an old
// pin's reading never depends on the live lowering.
//
// Loaded on the first parse that needs it, not when this module loads: a
// process whose movements are all on a version the language serves never
// compiles it. Outside Node, `await initFrozenParser(bytesOrUrl)` first.

// Declared here rather than taken from a lib, as the live loader does: this
// package compiles without the DOM and Node libs.
declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => WasmModule;
  Instance: new (module: WasmModule, imports: object) => { exports: Record<string, unknown> };
  compile(bytes: Uint8Array): Promise<WasmModule>;
};
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new (label: 'utf-8', options: { fatal: boolean }) => {
  decode(bytes: Uint8Array): string;
};
declare const fetch: (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
declare const process: { versions?: { node?: string }; getBuiltinModule?(id: string): unknown } | undefined;
declare const window: unknown;
declare const __dirname: string;

interface WasmModule {
  readonly __wasmModule?: never;
}

/** The parse exports the platform reads an old pin through. */
export type FrozenParserFunction = 'parse_program_eager' | 'parse_nested_call' | 'parse_expression';

/** The lowering exports the platform lowers an old pin's trees through. */
export type FrozenLoweringFunction = 'lower_expression' | 'lower_condition';

interface FrozenExports {
  memory: { readonly buffer: unknown };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  parse: Record<FrozenParserFunction | FrozenLoweringFunction, (...args: number[]) => unknown>;
}

const WASM_FILE = 'movement_parser.frozen.wasm';
const OK = 0;
const ERROR = 1;

let compiled: WasmModule | undefined;
// Absent after a trap: the next call instantiates afresh from `compiled`.
let current: FrozenExports | undefined;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Loads the frozen parser from its bytes or URL; in Node, with no argument,
 *  from the file beside this module (which the first parse also does). */
export async function initFrozenParser(bytesOrUrl?: Uint8Array | string): Promise<void> {
  if (bytesOrUrl === undefined) {
    loadedModule();
    return;
  }
  const bytes = typeof bytesOrUrl === 'string' ? await fetchBytes(bytesOrUrl) : bytesOrUrl;
  compiled = await WebAssembly.compile(bytes);
  current = undefined;
}

/** Whether a parse can run now: in Node always (it loads on demand), in a
 *  browser once `initFrozenParser` has resolved. */
export function isFrozenParserReady(): boolean {
  return compiled !== undefined || isNode();
}

/**
 * Calls one parse export of the frozen artifact, with the same contract as
 * the live loader's `callParser`: `input` as its (pointer, length) pair, then
 * `extra`, and the JSON it emits — the tree, or `{error: …}` — with whether
 * the export answered OK.
 */
export function callFrozenParser(
  fn: FrozenParserFunction,
  input: string,
  extra: number[],
): { ok: boolean; json: unknown } {
  return callFrozen(fn, [input], extra);
}

/**
 * Calls one lowering export of the frozen artifact, with the same contract
 * as the live loader's `callLowering`: the tree (as JSON) and the source it
 * was parsed from, and the JSON it emits — the lowered value, or `{error: …}`.
 */
export function callFrozenLowering(
  fn: FrozenLoweringFunction,
  treeJson: string,
  source: string,
): { ok: boolean; json: unknown } {
  return callFrozen(fn, [treeJson, source], []);
}

function callFrozen(
  fn: FrozenParserFunction | FrozenLoweringFunction,
  inputs: string[],
  extra: number[],
): { ok: boolean; json: unknown } {
  current ??= instantiate(loadedModule());
  const instance = current;
  let status: number;
  let text: string;
  try {
    const placed = inputs.map((input) => {
      const bytes = encoder.encode(input);
      const ptr = instance.alloc(bytes.length);
      new Uint8Array(memoryBuffer(instance)).set(bytes, ptr);
      return { ptr, len: bytes.length };
    });
    const slots = instance.alloc(8);
    const pairs = placed.flatMap(({ ptr, len }) => [ptr, len]);
    status = number(instance.parse[fn](...pairs, ...extra, slots, slots + 4), fn);
    for (const { ptr, len } of placed) instance.dealloc(ptr, len);
    const view = new DataView(memoryBuffer(instance));
    const outPtr = view.getUint32(slots, true);
    const outLen = view.getUint32(slots + 4, true);
    instance.dealloc(slots, 8);
    text = decoder.decode(new Uint8Array(memoryBuffer(instance)).subarray(outPtr, outPtr + outLen));
    instance.dealloc(outPtr, outLen);
  } catch (trap) {
    // A trap (a Rust panic aborts) leaves the heap in an unknown state, so
    // this instance is never called again.
    current = undefined;
    throw new Error(`the frozen movement parser crashed in ${fn}: ${String(trap)}`, { cause: trap });
  }
  if (status !== OK && status !== ERROR) {
    throw new Error(`the frozen movement parser returned unknown status ${status} from ${fn}`);
  }
  return { ok: status === OK, json: JSON.parse(text) };
}

function loadedModule(): WasmModule {
  if (compiled !== undefined) return compiled;
  if (!isNode()) {
    throw new Error(`the frozen movement parser is not ready: await initFrozenParser() with ${WASM_FILE}'s bytes or URL`);
  }
  // getBuiltinModule rather than require('fs'): bundlers resolve a literal
  // require for the browser and fail on `fs`.
  const fs = process?.getBuiltinModule?.('fs');
  if (typeof fs !== 'object' || fs === null || !('readFileSync' in fs) || typeof fs.readFileSync !== 'function') {
    throw new Error('this Node has no process.getBuiltinModule("fs") (needs Node 22.3+)');
  }
  const bytes: unknown = fs.readFileSync(`${__dirname}/${WASM_FILE}`);
  if (!ArrayBuffer.isView(bytes)) throw new Error(`reading ${WASM_FILE} did not return bytes`);
  compiled = new WebAssembly.Module(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return compiled;
}

function instantiate(module: WasmModule): FrozenExports {
  const raw = new WebAssembly.Instance(module, {}).exports;
  const exported = (name: string): ((...args: number[]) => unknown) => {
    const fn = raw[name];
    if (typeof fn !== 'function') throw new Error(`the frozen movement parser exports no ${name}()`);
    return (...args) => fn(...args);
  };
  const memory = raw.memory;
  if (typeof memory !== 'object' || memory === null || !('buffer' in memory)) {
    throw new Error('the frozen movement parser exports no memory');
  }
  const alloc = exported('alloc');
  const dealloc = exported('dealloc');
  return {
    memory,
    alloc: (len) => number(alloc(len), 'alloc'),
    dealloc: (ptr, len) => void dealloc(ptr, len),
    parse: {
      parse_program_eager: exported('parse_program_eager'),
      parse_nested_call: exported('parse_nested_call'),
      parse_expression: exported('parse_expression'),
      lower_expression: exported('lower_expression'),
      lower_condition: exported('lower_condition'),
    },
  };
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`the frozen movement parser's ${name}() returned ${typeof value}`);
  return value;
}

// Read afresh on every access: growing the memory detaches the old buffer.
function memoryBuffer(instance: Pick<FrozenExports, 'memory'>): ArrayBuffer {
  const buffer = instance.memory.buffer;
  if (!isArrayBuffer(buffer)) throw new Error('the frozen movement parser memory has no ArrayBuffer');
  return buffer;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  // A tag check rather than instanceof: under jest the buffer comes from
  // another realm.
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch the frozen movement parser from ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// The window check too: a bundler's browser `process` shim may carry
// `versions`, and a browser must never take the disk path.
function isNode(): boolean {
  return typeof window === 'undefined' && typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}
