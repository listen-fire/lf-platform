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

import type { PluginAnswers, PluginQuestion } from 'engine-contracts';

/** What one question is answered: the plugin's value, or why it could not be. */
export type PluginAnswer = { value: unknown } | { unreachable: string };

interface Kept {
  value: unknown;
  keptAtMs: number;
}

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
        team.kept.set(key, { value: answer.value, keptAtMs: this.#now() });
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
