// The model replies the Rust lf's reader is held to. A reply the model
// wrapped, truncated or got slightly wrong is read here by parseJsonReply
// (over the npm jsonrepair); lf reads it in Rust (over its port of
// jsonrepair). The fixture pairs each reply with this module's reading: this
// test holds the fixture to the module, and a cargo test
// (crates/lf/src/llm_calls.rs) holds lf to the fixture.
//
// Adding a case: append `{ "reply": "…" }` to the fixture and run this test
// with LF_UPDATE_FIXTURES=1, which writes every case's reading.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { parseJsonReply } from '../parse_json';

const FIXTURE = join(__dirname, '../fixtures/json_replies.json');

const cases = z
  .array(z.object({ reply: z.string(), parsed: z.string().optional() }))
  .parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));

it('reads each reply in the fixture as the fixture says', () => {
  const read = cases.map((c) => ({ reply: c.reply, parsed: JSON.stringify(parseJsonReply(c.reply)) }));
  if (process.env.LF_UPDATE_FIXTURES === '1') {
    writeFileSync(FIXTURE, `${JSON.stringify(read, null, 2)}\n`);
    return;
  }
  expect(read).toEqual(cases);
});
