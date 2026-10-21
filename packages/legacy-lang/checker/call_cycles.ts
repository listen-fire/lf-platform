// CALL CYCLES — functions that call each other in a loop (language version 3).
//
// From version 3 a function may call itself, directly or through others.
// Two facts about a function are inferred from its body — what it returns, and
// what it may do (its effect row) — and inference walks callees bottom-up,
// which a cycle defeats: a body that calls itself needs its own answer to give
// one. The resolution is TypeScript's for the first fact, and the graph's for
// the second:
//
//   - what a function in a cycle RETURNS is declared, not inferred
//     (`function f(n: <number>): <number> { … }`), so a call inside the cycle
//     is typed by the declaration. The checker requires the declaration on
//     every function in a cycle and checks each `return` against it.
//   - what it may DO is shared. Every function in a strongly connected
//     component (a set of functions each of which can reach the others) may end
//     up running every other's body, so they all get one row: the union of
//     their bodies'.
//
// Components are found WHILE inferring, not by a separate pass over a call
// graph: the checker's own call resolution (scopes, imports, letter case,
// closures) is what says which declaration a call reaches, and a separate
// graph would be a second resolver to keep in step with it. Inference keeps a
// stack of the bodies it is walking. A call that reaches one still on the
// stack, or one already walked whose component has not closed yet, is a back
// edge: everything on the stack from that component's first member up joins
// it. The component closes when its first member's walk finishes, and only
// then is its row known. This is Tarjan's algorithm, run on the recursion the
// checker already does.

import { type EffectRow, unionRows } from './effects';

/** What the stack needs of a function: its name (for the message) and the
 *  three facts it keeps on the declaration. */
export interface CycleMember {
  readonly decl: { readonly name: string };
  /** The stack depth its body is being walked at; undefined when it is not. */
  walking?: number;
  /** The component it belongs to, once it is known to be in one. */
  cycle?: CallCycle;
  effects?: EffectRow;
}

/** One strongly connected component of the call graph: functions that can
 *  each reach the others. */
export class CallCycle {
  readonly members = new Set<CycleMember>();
  /** Each walked member's own body's row, calls into the component left out. */
  readonly rows = new Map<CycleMember, EffectRow>();
  closed = false;

  constructor(
    /** The stack depth of the member entered first: the component closes
     *  when that walk finishes. */
    public rootDepth: number,
    /** The first loop found, by name — `even → odd → even` — for messages. */
    readonly chain: readonly string[],
  ) {}

  /** The loop as seen from `name`: the chain rotated to start and end there,
   *  when it passes through it. */
  chainFrom(name: string): string[] {
    const loop = this.chain.slice(0, -1);
    const at = loop.indexOf(name);
    if (at < 0) return [...this.chain];
    const rotated = [...loop.slice(at), ...loop.slice(0, at)];
    return [...rotated, name];
  }
}

export class InferenceStack {
  private readonly stack: CycleMember[] = [];

  /** `member`'s body is about to be walked. */
  enter(member: CycleMember): void {
    member.walking = this.stack.length;
    this.stack.push(member);
  }

  /**
   * A call reached `target`. True when that closes a loop — `target` is still
   * being walked, or belongs to a component still open — in which case every
   * body on the stack from the component's first member up is in it, and the
   * call adds nothing to the caller's row: the component's shared row will
   * hold it.
   */
  reaches(target: CycleMember): boolean {
    const open = target.cycle !== undefined && !target.cycle.closed ? target.cycle : undefined;
    if (target.walking === undefined && open === undefined) return false;
    const rootDepth = Math.min(target.walking ?? Infinity, open?.rootDepth ?? Infinity);
    const from = target.walking ?? rootDepth;
    const cycle =
      open ?? new CallCycle(rootDepth, [...this.stack.slice(from).map(m => m.decl.name), target.decl.name]);
    cycle.rootDepth = Math.min(cycle.rootDepth, rootDepth);
    for (let depth = rootDepth; depth < this.stack.length; depth++) this.join(cycle, this.stack[depth]);
    this.join(cycle, target);
    return true;
  }

  /**
   * `member`'s walk finished with `row`, its own body's row. Outside any
   * component that IS its row. Inside one, the row waits for the component to
   * close — when its first member finishes — and then every member gets the
   * union.
   */
  leave(member: CycleMember, row: EffectRow): void {
    const depth = member.walking;
    this.stack.pop();
    member.walking = undefined;
    const cycle = member.cycle;
    if (cycle === undefined || cycle.closed) {
      member.effects = row;
      return;
    }
    cycle.rows.set(member, row);
    if (depth !== cycle.rootDepth) return;
    const shared = unionRows(cycle.rows.values());
    for (const each of cycle.members) each.effects = shared;
    cycle.closed = true;
  }

  private join(cycle: CallCycle, member: CycleMember): void {
    const other = member.cycle;
    if (other === cycle) return;
    // Two loops that share a function are one component.
    if (other !== undefined && !other.closed) {
      cycle.rootDepth = Math.min(cycle.rootDepth, other.rootDepth);
      for (const each of other.members) {
        each.cycle = cycle;
        cycle.members.add(each);
      }
      for (const [each, row] of other.rows) cycle.rows.set(each, row);
    }
    member.cycle = cycle;
    cycle.members.add(member);
  }
}
