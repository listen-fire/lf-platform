import type { Step } from 'legacy-lang';
import type { StoryView, StoryViewTrigger } from "./view";

/**
 * A FILE is a SET of independent stories — one per fired movement — plus
 * shared helpers, never one combined spine. This is the one place that
 * carves `view.flow` into those pieces, so the canvas and the step list can't
 * disagree about which trigger belongs to which movement.
 *
 * Root cause this replaces: the canvas used to draw every fired movement down
 * one spine with a connector between them (as if B ran after A) under one
 * "Starts when" that fanned every trigger in, regardless of which movement
 * each one actually fires.
 *
 */

export type MovementStep = Extract<Step, { kind: "movement" }>;

export interface FiredSection {
  movement: MovementStep;
  /** Only the triggers whose `fires` names THIS movement. */
  triggers: StoryViewTrigger[];
}

export interface FlowSections {
  /** Top-level steps outside any movement declaration. */
  loose: Step[];
  /** Movements at least one trigger fires, each paired with only its own
   *  triggers — never the whole file's. */
  fired: FiredSection[];
  /** Triggers whose `fires` names nothing declared here. The named hole is
   *  already shown on the trigger's own card; these still fan in together
   *  when they name the same (missing) movement. */
  orphanTriggers: StoryViewTrigger[][];
  /** Movements no trigger fires — the shared helpers. */
  helpers: MovementStep[];
}

function isMovementStep(step: Step): step is MovementStep {
  return step.kind === "movement";
}

export function sectionsOf(view: StoryView): FlowSections {
  const declared = view.flow.filter(isMovementStep);
  const loose = view.flow.filter((step) => step.kind !== "movement");

  const byFires = new Map<string, StoryViewTrigger[]>();
  for (const trigger of view.triggers) {
    const list = byFires.get(trigger.fires);
    if (list) list.push(trigger);
    else byFires.set(trigger.fires, [trigger]);
  }

  const fired: FiredSection[] = [];
  const helpers: MovementStep[] = [];
  for (const movement of declared) {
    const triggers = byFires.get(movement.name);
    if (triggers) fired.push({ movement, triggers });
    else helpers.push(movement);
  }

  const declaredNames = new Set(declared.map((movement) => movement.name));
  const orphanTriggers = [...byFires.entries()]
    .filter(([name]) => !declaredNames.has(name))
    .map(([, triggers]) => triggers);

  return { loose, fired, orphanTriggers, helpers };
}

// ── The board ────────────────────────────────────────────────────────────────

/**
 * One column of the canvas. A file's independent stories stand SIDE BY SIDE —
 * each read top to bottom — rather than stacked, because stacking put two
 * things that never run together in the one arrangement that means "and then".
 *
 */
export type FlowColumn = { key: string } & (
  | { kind: "loose"; steps: Step[] }
  | { kind: "fired"; movement: MovementStep; triggers: StoryViewTrigger[] }
  | { kind: "orphan"; triggers: StoryViewTrigger[] }
  | { kind: "helper"; movement: MovementStep }
);

/**
 * Fired movements in program order, then the triggers that name nothing, then
 * the helpers — the reading order the stacked canvas already had.
 *
 * A column carries no width and nothing measured from its shape: it is as wide
 * as what is drawn in it, which the canvas gets from layout rather than from a
 * count made here. (This is where a `widestFan` — lanes at the widest point of
 * a story, multiplied out through nesting — used to be computed to set a
 * column's width in advance; content sizing answers the same question exactly,
 * including the part that count could only approximate: how wide a lane's
 * contents actually are.)
 *
 */
export function columnsOf(sections: FlowSections): FlowColumn[] {
  const columns: FlowColumn[] = [];
  if (sections.loose.length > 0) {
    columns.push({ key: "loose", kind: "loose", steps: sections.loose });
  }
  for (const [index, section] of sections.fired.entries()) {
    columns.push({
      key: `fired:${index}:${section.movement.name}`,
      kind: "fired",
      ...section,
    });
  }
  for (const [index, triggers] of sections.orphanTriggers.entries()) {
    columns.push({ key: `orphan:${index}`, kind: "orphan", triggers });
  }
  for (const [index, movement] of sections.helpers.entries()) {
    columns.push({
      key: `helper:${index}:${movement.name}`,
      kind: "helper",
      movement,
    });
  }
  return columns;
}

/**
 * Every movement the file declares, by name — how a call site finds the
 * PARAMETER its argument fills. Nested declarations included, for the same
 * reason `collectCallers` walks the whole file: a helper may declare another.
 */
export function movementsByName(flow: Step[]): Map<string, MovementStep> {
  const found = new Map<string, MovementStep>();
  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      switch (step.kind) {
        case "movement":
          found.set(step.name, step);
          walk(step.steps);
          break;
        case "branch":
          for (const arm of step.arms) walk(arm.steps);
          if (step.otherwise) walk(step.otherwise.steps);
          break;
        case "race":
          for (const branch of step.branches) walk(branch.steps);
          break;
        case "group":
        case "callback":
          walk(step.steps);
          break;
        default:
          break;
      }
    }
  };
  walk(flow);
  return found;
}

export type RaceStep = Extract<Step, { kind: "race" }>;

/**
 * Every race the file runs, by the name it binds — how a RECEIPT branch finds
 * the race it is a branch of.
 *
 * `r-[:timeout]->` is a walk off a race's result, and on its own it can only
 * be read as "something called timeout came back". Held against the race, it is
 * one of that race's contenders, and the contender says what actually happened.
 * Nothing here reads the edge name as a word — it is COMPARED to what the
 * contenders bound, which is the author's own name for the same thing.
 *
 */
export function racesByBinding(flow: Step[]): Map<string, RaceStep> {
  const found = new Map<string, RaceStep>();
  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      switch (step.kind) {
        case "race":
          if (step.binding !== undefined) found.set(step.binding, step);
          for (const branch of step.branches) walk(branch.steps);
          break;
        case "branch":
          for (const arm of step.arms) walk(arm.steps);
          if (step.otherwise) walk(step.otherwise.steps);
          break;
        case "movement":
        case "group":
        case "callback":
          walk(step.steps);
          break;
        default:
          break;
      }
    }
  };
  walk(flow);
  return found;
}

/**
 * The step inside a race that BOUND this name — the contender a receipt edge
 * names. A race branch is a body, and what it waits on is its first step, which
 * is exactly what the lane label above it is written from.
 */
export function contenderNamed(race: RaceStep, name: string): Step | undefined {
  for (const branch of race.branches) {
    const first = branch.steps[0];
    if (first === undefined) continue;
    if ("binding" in first && first.binding === name) return first;
  }
  return undefined;
}

// ── Who calls a helper ───────────────────────────────────────────────────────

/** The fallback caller label for a `call` made outside any movement — steps
 *  that just run on their own, rather than something with a name to point to. */
const TOP_LEVEL_CALLER = "the steps above";

/**
 * Every movement a `call` step names, keyed by callee, with the names of
 * whoever calls it. Walks the whole file once — a helper can call another
 * helper, so this is never scoped to the fired movements alone.
 */
export function collectCallers(flow: Step[]): Map<string, Set<string>> {
  const callers = new Map<string, Set<string>>();
  const note = (callee: string, caller: string): void => {
    const set = callers.get(callee);
    if (set) set.add(caller);
    else callers.set(callee, new Set([caller]));
  };

  const walk = (steps: Step[], caller: string): void => {
    for (const step of steps) {
      if (step.kind === "call" && step.isMovement) note(step.movement, caller);
      switch (step.kind) {
        case "movement":
          walk(step.steps, step.name);
          break;
        case "branch":
          for (const arm of step.arms) walk(arm.steps, caller);
          if (step.otherwise) walk(step.otherwise.steps, caller);
          break;
        case "race":
          for (const branch of step.branches) walk(branch.steps, caller);
          break;
        case "group":
        case "callback":
          walk(step.steps, caller);
          break;
        default:
          break;
      }
    }
  };

  walk(flow, TOP_LEVEL_CALLER);
  return callers;
}

/**
 * Whoever runs a helper, in the order the file declares them. Empty is a real
 * answer — a helper nobody reaches yet — and the canvas says so rather than
 * falling back to the old blanket "used by the steps above", which was a guess
 * dressed up as a fact.
 */
export function callersOf(name: string, callers: Map<string, Set<string>>): string[] {
  return [...(callers.get(name) ?? [])];
}
