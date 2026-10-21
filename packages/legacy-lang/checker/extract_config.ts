// `extract(content, Shape, { tier, model, effort })` — the settings record the
// extraction call may be given after its shape.
//
// The checker and the engine both read it through `readExtractCallConfig`, so
// what was refused at save and what the run asks the platform for cannot
// disagree. Every value is WRITTEN DOWN (as `MAP`'s settings are): which model
// answers and how hard it thinks are facts the checker has to see to refuse a
// misspelt one, and a computed value would move that refusal into the middle
// of a run. Unknown keys are refused, TypeScript's excess-property check.

import { isObjectSpread, type Expression } from 'movement-lang/expression/types';
import { AI_EFFORTS, AI_TIERS, aiTier, type AiEffort, type AiTier } from 'movement-lang/expression/types';

import { didYouMean } from './meta';

/** What an extraction call asks the platform for, beyond its tier's defaults.
 *  Absent = the deployment's tier assignment decides. */
export interface ExtractCallSettings {
  tier?: AiTier;
  /** A logical model name this deployment can reach. */
  model?: string;
  effort?: AiEffort;
}

const SETTINGS: ReadonlyArray<{ key: keyof ExtractCallSettings; summary: string }> = [
  { key: 'tier', summary: `how much the job is worth: ${AI_TIERS.map((t) => `'${t}'`).join(', ')}` },
  { key: 'model', summary: "a model this deployment can reach, by its name ('claude-opus-5'), in place of the tier's" },
  { key: 'effort', summary: `how hard that model thinks: ${AI_EFFORTS.map((e) => `'${e}'`).join(', ')}, in place of the tier's` },
];

const SETTING_KEYS = SETTINGS.map((setting) => setting.key);

export type ExtractCallConfigReading =
  | { ok: true; settings: ExtractCallSettings }
  | { ok: false; problems: string[] };

/**
 * The settings, read off the record as it was parsed. `models` is the list of
 * logical models this deployment reaches (`Catalog.models`), when the caller
 * knows it: a name outside a KNOWN list is refused, and an unknown list
 * refuses nothing — "nobody told us" is not "none are reachable".
 */
export function readExtractCallConfig(
  record: Expression,
  options: { models?: readonly string[] } = {},
): ExtractCallConfigReading {
  const inventory = SETTINGS.map((setting) => `${setting.key} — ${setting.summary}`).join('; ');
  if (record.type !== 'object') {
    return {
      ok: false,
      problems: [
        `'extract' takes its settings as a record written in place — \`extract(content, Shape, { tier: 'careful' })\`. The settings are: ${inventory}`,
      ],
    };
  }
  const problems: string[] = [];
  const written = new Map<keyof ExtractCallSettings, Expression>();
  for (const entry of record.entries) {
    if (isObjectSpread(entry)) {
      problems.push(`'extract' takes its settings written out one by one — a spread ('...') is not accepted here. The settings are: ${inventory}`);
      continue;
    }
    if (!isSettingKey(entry.key)) {
      problems.push(
        `'extract' has no setting '${entry.key}'${didYouMean(entry.key, SETTING_KEYS)}. The settings are: ${inventory}`,
      );
      continue;
    }
    if (written.has(entry.key)) {
      problems.push(`'extract' is given '${entry.key}' twice — write it once`);
      continue;
    }
    written.set(entry.key, entry.value);
  }

  const settings: ExtractCallSettings = {};
  const tierValue = written.get('tier');
  if (tierValue !== undefined) {
    const word = writtenWord(tierValue, 'tier', problems);
    if (word !== undefined) {
      const tier = aiTier(word);
      if (tier === undefined) {
        problems.push(
          `'extract': there is no tier '${word}'${didYouMean(word, AI_TIERS)} — write one of ${AI_TIERS.map((t) => `'${t}'`).join(', ')}`,
        );
      } else {
        settings.tier = tier;
      }
    }
  }
  const effortValue = written.get('effort');
  if (effortValue !== undefined) {
    const word = writtenWord(effortValue, 'effort', problems);
    if (word !== undefined) {
      const effort = AI_EFFORTS.find((e) => e === word);
      if (effort === undefined) {
        problems.push(
          `'extract': there is no effort '${word}'${didYouMean(word, AI_EFFORTS)} — write one of ${AI_EFFORTS.map((e) => `'${e}'`).join(', ')}`,
        );
      } else {
        settings.effort = effort;
      }
    }
  }
  const modelValue = written.get('model');
  if (modelValue !== undefined) {
    const word = writtenWord(modelValue, 'model', problems);
    if (word !== undefined) {
      if (options.models !== undefined && !options.models.includes(word)) {
        problems.push(
          options.models.length === 0
            ? `'extract': this deployment reaches no model it can name, so '${word}' cannot be asked for here — drop 'model' and let the tier choose`
            : `'extract': '${word}' is not a model this deployment reaches${didYouMean(word, options.models)} — it reaches ${options.models.map((m) => `'${m}'`).join(', ')}`,
        );
      } else {
        settings.model = word;
      }
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, settings };
}

function isSettingKey(key: string): key is keyof ExtractCallSettings {
  return (SETTING_KEYS as ReadonlyArray<string>).includes(key);
}

function writtenWord(
  value: Expression,
  key: keyof ExtractCallSettings,
  problems: string[],
): string | undefined {
  if (value.type === 'static' && typeof value.value === 'string') return value.value;
  problems.push(`'extract': '${key}' is written down, not worked out — write ${key}: '…' as a quoted word`);
  return undefined;
}
