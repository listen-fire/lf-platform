// What a call costs under the price table, case by case from the fixture the
// Rust lf's pricing test reads too (crates/lf/src/models.rs): the two bill a
// call to the same microdollar.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { costMicrodollars } from '../pricing';

const fixture = z
  .object({
    cases: z.array(
      z.object({
        key: z.string(),
        tokens: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        microdollars: z.number().nullable(),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(join(__dirname, '../fixtures/cost_cases.json'), 'utf8')));

describe('costMicrodollars', () => {
  it.each(fixture.cases)('prices $key at $tokens', ({ key, tokens, microdollars }) => {
    const [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens] = tokens;
    expect(costMicrodollars(key, { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }) ?? null).toBe(microdollars);
  });
});
