// The platform's answers to a listen's host-function questions, kept. The
// judge asks `team.isMember(address)` once per arrival; a team's members
// change rarely, so the answer to a question is kept per team until the team
// changes (`invalidateTeam`, from the membership change feed) or the plugin's
// declared maximum age passes, whichever comes first.
//
// Only a value is kept. An unreachable host is asked again next time, and an
// answer that was being fetched when its team changed is handed to the one who
// asked but never kept, so a removed member cannot come back through a
// question that was already in flight.

import { AdapterBadRequestError, ModuleAnswerInvalid } from 'module-kit';

import type { PluginAnswers, PluginQuestion } from 'engine-contracts';
import type { PluginOutput, PluginSpec, SchemaFieldType } from 'movement-lang';

import { SECOND } from '../../constants';

/** How often what waits on a host function its host could not reach is
 *  judged again: a listen's waiting arrivals, and a wait's. */
export const RETRY_UNJUDGED_EVERY_MS = 30 * SECOND;

/** What one question is answered: the plugin's value, or why it could not be. */
export type PluginAnswer = { value: unknown } | { unreachable: string };

/** A host function's module answered an error of its own, or an answer that
 *  is none: asking again would answer the same, so its arrival is not kept
 *  waiting for it. */
export class HostFunctionRefused extends Error {
  constructor(
    readonly plugin: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostFunctionRefused';
  }
}

interface Kept {
  value: unknown;
  keptAtMs: number;
  maxAgeMs: number;
}

/** A team's kept answers are bounded because the questions are partly an
 *  outsider's: every distinct sender address on an inbound arrival is a new key.
 *  Large enough that a team's real senders stay kept; small enough that a flood
 *  of made-up addresses costs a bounded amount of memory. */
export const MAX_KEPT_ANSWERS_PER_TEAM = 10_000;

interface TeamAnswers {
  /** Bumped by every invalidation: an answer is kept only if its team's
   *  generation is the one it was asked under. */
  generation: number;
  kept: Map<string, Kept>;
  asking: Map<string, Promise<PluginAnswer>>;
}

export interface PluginAnswerCacheOptions {
  /** How long an answer to `plugin` (its catalog key) may be kept, in seconds;
   *  undefined keeps none. */
  maxAgeSeconds(plugin: string): number | undefined;
  now?: () => number;
  /** How many answers one team may hold; the oldest go first. */
  maxKeptPerTeam?: number;
  /** Settles when invalidations will be heard (the feed is listening). Answers
   *  wait for it, so nothing is kept that a change could have made stale
   *  unheard. */
  ready?: () => Promise<void>;
}

/** The same question, whoever spells it: the plugin and its arguments. */
function keyOf(question: PluginQuestion): string {
  return JSON.stringify([question.plugin, question.args]);
}

export class PluginAnswerCache {
  readonly #teams = new Map<string, TeamAnswers>();
  readonly #options: PluginAnswerCacheOptions;

  constructor(options: PluginAnswerCacheOptions) {
    this.#options = options;
  }

  /** The answers to `questions` for `teamId`: kept ones at no cost, the rest
   *  asked through `ask` (once, however many want it at the same time). */
  async answers(teamId: string, questions: PluginQuestion[], ask: (question: PluginQuestion) => Promise<PluginAnswer>): Promise<PluginAnswers> {
    await this.#options.ready?.();
    const team = this.#team(teamId);
    return Promise.all(
      questions.map(async (question): Promise<PluginAnswers[number]> => ({ ...question, ...(await this.#answer(team, question, ask)) })),
    );
  }

  /** How many answers are kept for `teamId`. */
  keptCount(teamId: string): number {
    return this.#teams.get(teamId)?.kept.size ?? 0;
  }

  /** Forgets every answer kept for `teamId` (a membership of it changed). */
  invalidateTeam(teamId: string): void {
    const team = this.#teams.get(teamId);
    if (team === undefined) return;
    team.generation += 1;
    team.kept.clear();
    team.asking.clear();
  }

  /** Forgets everything, for every team (the change feed was lost, so any team
   *  may have changed unheard). */
  invalidateAll(): void {
    for (const teamId of this.#teams.keys()) this.invalidateTeam(teamId);
  }

  #team(teamId: string): TeamAnswers {
    const held = this.#teams.get(teamId);
    if (held !== undefined) return held;
    const fresh: TeamAnswers = { generation: 0, kept: new Map(), asking: new Map() };
    this.#teams.set(teamId, fresh);
    return fresh;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** Keeps `entry`, first dropping the team's aged answers and, if the team is
   *  still full, its oldest. A map iterates in insertion order, so oldest is first. */
  #keep(team: TeamAnswers, key: string, entry: Kept): void {
    const now = this.#now();
    for (const [heldKey, held] of team.kept) {
      if (now - held.keptAtMs >= held.maxAgeMs) team.kept.delete(heldKey);
    }
    team.kept.delete(key);
    const cap = this.#options.maxKeptPerTeam ?? MAX_KEPT_ANSWERS_PER_TEAM;
    for (const oldest of team.kept.keys()) {
      if (team.kept.size < cap) break;
      team.kept.delete(oldest);
    }
    team.kept.set(key, entry);
  }

  async #answer(team: TeamAnswers, question: PluginQuestion, ask: (question: PluginQuestion) => Promise<PluginAnswer>): Promise<PluginAnswer> {
    const key = keyOf(question);
    const maxAgeSeconds = this.#options.maxAgeSeconds(question.plugin);
    const kept = team.kept.get(key);
    if (kept !== undefined) {
      if (maxAgeSeconds !== undefined && this.#now() - kept.keptAtMs < maxAgeSeconds * 1000) return { value: kept.value };
      team.kept.delete(key);
    }
    const inFlight = team.asking.get(key);
    if (inFlight !== undefined) return inFlight;
    const generation = team.generation;
    const asked = ask(question).then((answer) => {
      if ('value' in answer && maxAgeSeconds !== undefined && team.generation === generation) {
        this.#keep(team, key, { value: answer.value, keptAtMs: this.#now(), maxAgeMs: maxAgeSeconds * 1000 });
      }
      return answer;
    });
    team.asking.set(key, asked);
    // Whether it answers or throws, the next question is a fresh one. After an
    // invalidation the map holds a newer asking (or none) under this key.
    const forget = () => {
      if (team.asking.get(key) === asked) team.asking.delete(key);
    };
    asked.then(forget, forget);
    return asked;
  }
}

// ── Asking a plugin's module ────────────────────────────────────────────────

/** What a plugin module answers a call (adapter protocol `invokePlugin`). */
export interface PluginResult {
  text?: string;
  data?: Record<string, unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function admitsAbsent(type: SchemaFieldType): boolean {
  return type === 'absent' || type === 'json' || (typeof type === 'object' && type.kind === 'maybeAbsent');
}

/** Whether `value` is one of `type`. A brand is the module's word, so a
 *  branded value is checked as what it narrows; a field read off a record
 *  holds the record's fields. */
function fits(value: unknown, type: SchemaFieldType): boolean {
  if (value === null || value === undefined) return admitsAbsent(type);
  if (typeof type === 'string') {
    switch (type) {
      case 'text':
      case 'date':
      case 'datetime':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'json':
        return true;
      case 'file':
        return typeof value === 'object';
      case 'absent':
      case 'never':
        return false;
      default:
        return neverType(type);
    }
  }
  switch (type.kind) {
    case 'list':
      return Array.isArray(value) && value.every((item) => fits(item, type.of));
    case 'tuple':
      return Array.isArray(value) && value.length === type.of.length && value.every((item, place) => { const at = type.of[place]; return at === null || at === undefined || fits(item, at); });
    case 'dict':
      return typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((item) => fits(item, type.of));
    case 'enum':
      return typeof value === 'string' && (type.open !== undefined || type.options.includes(value));
    case 'owned':
      return typeof value === 'string';
    case 'maybeAbsent':
    case 'branded':
      return fits(value, type.of);
    case 'record':
      return typeof value === 'object' && !Array.isArray(value);
    default:
      return neverType(type);
  }
}

function neverType(type: never): boolean {
  throw new Error(`a field type the host does not know: ${JSON.stringify(type)}`);
}

/** The value in a module's answer, as a run reads it, held to the plugin's
 *  declared output (`malformed` says how it is not). A value output is
 *  `data.value`, or the text it answered (first, for a text value). A record
 *  is `data`'s entries and its text; one that may be none is none when the
 *  answer has neither (`data: {}` is a record of absent fields). */
export function declaredValue(answered: PluginResult, output: PluginOutput | undefined): { value: unknown } | { malformed: string } {
  if (output === undefined) return { malformed: 'it declares no output' };
  switch (output.kind) {
    case 'value': {
      const fromData = answered.data !== undefined && Object.hasOwn(answered.data, 'value') ? answered.data.value : undefined;
      const fromText = answered.text;
      const value = output.type === 'text' ? (fromText ?? fromData) : (fromData ?? fromText);
      if (value === undefined && !admitsAbsent(output.type)) return { malformed: 'it answered no value' };
      return fits(value, output.type) ? { value: value ?? null } : { malformed: `it answered ${JSON.stringify(value)}, which is not its declared ${JSON.stringify(output.type)}` };
    }
    case 'record': {
      const { data, text } = answered;
      if (data === undefined || data === null) {
        if (output.maybeAbsent !== true) return { malformed: 'it answered no record' };
        if (text !== undefined) return { malformed: 'it answered text without `data`; a record is its `data` object, and none is an answer with neither' };
        return { value: null };
      }
      if (typeof data !== 'object' || Array.isArray(data)) return { malformed: `it answered a \`data\` that is not an object (${JSON.stringify(data)})` };
      const record: Record<string, unknown> = { ...(text !== undefined ? { text } : {}), ...data };
      for (const [name, type] of Object.entries(output.fields)) {
        if (!fits(record[name], type)) return { malformed: `its field ${name} answered ${JSON.stringify(record[name])}, which is not its declared ${JSON.stringify(type)}` };
      }
      return { value: record };
    }
    case 'records':
      return { malformed: 'it declares a list of records, which no filter can ask' };
    default:
      return neverOutput(output);
  }
}

function neverOutput(output: never): { malformed: string } {
  throw new Error(`a plugin output the host does not know: ${JSON.stringify(output)}`);
}

/**
 * One question asked of the module that serves its plugin: its arguments
 * bound to the plugin's parameters in the order it declares them, as a
 * program's call binds them, and the value its answer holds read as its
 * declared output. A refusal the module declares (a bad request), an answer
 * that is not its declared output, or too many arguments refuse
 * (`HostFunctionRefused`): asking again would answer the same. Anything else
 * it throws (its records failing for a moment) leaves it out of reach, so its
 * arrival waits.
 */
export async function askPluginModule(input: {
  plugin: string;
  args: readonly unknown[];
  spec: Pick<PluginSpec, 'args' | 'output'>;
  invoke: (config: Record<string, unknown>) => Promise<PluginResult>;
}): Promise<PluginAnswer> {
  const { plugin, args, spec } = input;
  if (args.length > spec.args.length) throw new HostFunctionRefused(plugin, `it takes ${spec.args.length} arguments, and was asked with ${args.length}`);
  const config = Object.fromEntries(args.map((value, place) => [spec.args[place], value]));
  let answered: PluginResult;
  try {
    answered = await input.invoke(config);
  } catch (error) {
    if (error instanceof AdapterBadRequestError || error instanceof ModuleAnswerInvalid) throw new HostFunctionRefused(plugin, messageOf(error));
    return { unreachable: `its module could not answer (${messageOf(error)})` };
  }
  const read = declaredValue(answered, spec.output);
  if ('malformed' in read) throw new HostFunctionRefused(plugin, read.malformed);
  return read;
}
