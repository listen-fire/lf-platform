import type { RecordUsageOptions } from '../llm_usage';
import type { EngineLogLine } from 'movement-engine/public/log';

// Pricing a call, and saying so when we cannot.
//
// An unpriced model records its real token count at zero cost — usage that reads
// as free rather than as missing. Nothing distinguishes the two except somebody
// being told, which is what the warning is for.

// The module loads in an isolated registry, whose logger is its own, so the
// sink is installed there rather than through the shared capture helper.
let logged: EngineLogLine[] = [];
const warnings = () => logged.filter((line) => line.level === 'warn');

const insertInto = jest.fn();
jest.mock('../kysely', () => ({ getQb: () => ({ insertInto }) }));

function load() {
  let mod: typeof import('../llm_usage') | undefined;
  jest.isolateModules(() => {
    const log: typeof import('movement-engine/public/log') = require('movement-engine/public/log');
    log.routeEngineLogsTo((line) => {
      logged.push(line);
    });
    mod = require('../llm_usage');
  });
  if (!mod) throw new Error('module did not load');
  return mod;
}

beforeEach(() => {
  logged = [];
  insertInto.mockReset();
});

/** `recordLlmUsage` needs a team in context and otherwise no-ops, so pricing is
 *  reached through a run that does write a row. */
async function record(mod: typeof import('../llm_usage'), resolved: RecordUsageOptions['resolved']) {
  const execute = jest.fn().mockResolvedValue(undefined);
  insertInto.mockReturnValue({ values: jest.fn().mockReturnValue({ execute }) });
  await new mod.LlmUsageContext({ teamId: 'team-1' as never }).runAsync(async () => {
    await mod.recordLlmUsage({
      resolved,
      callType: 'chat',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
  });
  return insertInto.mock.results[0]?.value.values.mock.calls[0]?.[0];
}

describe('a call the model map resolved', () => {
  it('records who served it, the wire model, and the name the caller asked for', async () => {
    const row = await record(load(), { preferred: 'claude-sonnet-5', provider: 'gemini', wireModel: 'gemini-3.8-flash' });
    expect(row.provider).toBe('gemini');
    expect(row.model).toBe('gemini-3.8-flash');
    expect(row.preferred_model).toBe('claude-sonnet-5');
  });

  it('is priced by provider and wire model, not by the name asked for', async () => {
    const mod = load();
    const onGemini = await record(mod, { preferred: 'claude-sonnet-5', provider: 'gemini', wireModel: 'gemini-3.8-flash' });
    insertInto.mockReset();
    const onAnthropic = await record(mod, { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' });
    expect(onGemini.cost_microdollars).toBe(1_500_000);
    expect(onAnthropic.cost_microdollars).toBe(2_000_000);
  });

  it('prices Claude on Vertex as on Anthropic’s own API', async () => {
    const mod = load();
    const vertex = await record(mod, { preferred: 'claude-opus-5', provider: 'vertex', wireModel: 'claude-opus-5' });
    insertInto.mockReset();
    const anthropic = await record(mod, { preferred: 'claude-opus-5', provider: 'anthropic', wireModel: 'claude-opus-5' });
    expect(vertex.cost_microdollars).toBe(anthropic.cost_microdollars);
    expect(vertex.cost_microdollars).toBeGreaterThan(0);
  });

  it('prices every wire model the Gemini provider files call', async () => {
    const mod = load();
    for (const resolved of [
      { preferred: 'claude-opus-5', provider: 'gemini', wireModel: 'gemini-3.1-pro-preview' },
      { preferred: 'whisper-1', provider: 'gemini', wireModel: 'gemini-3.8-flash' },
      { preferred: 'text-embedding-3-large', provider: 'gemini', wireModel: 'gemini-embedding-001' },
    ] as const) {
      insertInto.mockReset();
      const row = await record(mod, resolved);
      expect(row.cost_microdollars).toBeGreaterThan(0);
    }
    expect(warnings()).toEqual([]);
  });

  it('prices every Claude name the registry holds, on both Claude doors', async () => {
    const mod = load();
    for (const name of [
      'claude-fable-5-1',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
    ] as const) {
      for (const provider of ['anthropic', 'vertex'] as const) {
        insertInto.mockReset();
        const row = await record(mod, { preferred: name, provider, wireModel: name });
        expect(row.cost_microdollars).toBeGreaterThan(0);
      }
    }
    expect(warnings()).toEqual([]);
  });

  it('prices Fable 5.1 and the undated Haiku from the published table', async () => {
    const mod = load();
    const fable = await record(mod, { preferred: 'claude-fable-5-1', provider: 'anthropic', wireModel: 'claude-fable-5-1' });
    insertInto.mockReset();
    const haiku = await record(mod, { preferred: 'claude-haiku-4-5', provider: 'vertex', wireModel: 'claude-haiku-4-5' });
    expect(fable.cost_microdollars).toBe(10_000_000);
    expect(haiku.cost_microdollars).toBe(1_000_000);
  });

  it('prices gpt-image-1 by its tokens', async () => {
    const row = await record(load(), { preferred: 'gpt-image-1', provider: 'openai', wireModel: 'gpt-image-1' });
    expect(row.cost_microdollars).toBe(5_000_000);
  });

  it('prices GPT chat, which the map can still send a Claude name to', async () => {
    const row = await record(load(), { preferred: 'claude-sonnet-5', provider: 'openai', wireModel: 'gpt-5' });
    expect(row.cost_microdollars).toBe(1_250_000);
  });
});

describe('Jev, which no map line routes', () => {
  it('records the vendor and its model with no preferred name', async () => {
    const row = await record(load(), { provider: 'jev', wireModel: 'jev-1' });
    expect(row.provider).toBe('jev');
    expect(row.model).toBe('jev-1');
    expect(row.preferred_model).toBeNull();
  });

  it('is priced at $0.042 per million input tokens, whatever model name it answers under', async () => {
    const mod = load();
    const row = await record(mod, { provider: 'jev', wireModel: 'jev-2026-10' });
    expect(row.cost_microdollars).toBe(42_000);
    expect(warnings()).toHaveLength(0);
  });
});

describe('a key nobody priced', () => {
  it('still records the row, at zero, and names the map line that produced it', async () => {
    const mod = load();
    const row = await record(mod, { preferred: 'claude-sonnet-5', provider: 'gemini', wireModel: 'gemini-99-imaginary' });
    expect(row.cost_microdollars).toBe(0);
    expect(row.input_tokens).toBe(1_000_000);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toMatch(
      /no price for "gemini\/gemini-99-imaginary" \(from the MODEL_MAP line "claude-sonnet-5": "gemini\/gemini-99-imaginary"\)/,
    );
  });

  it('names the map’s silence when the name went to its home vendor', async () => {
    const mod = load();
    await record(mod, { preferred: 'whisper-1', provider: 'openai', wireModel: 'whisper-1' });
    expect(warnings()[0]?.message).toMatch(/"whisper-1", which MODEL_MAP does not mention/);
  });

  it('says so once per KEY, not once per call', async () => {
    const mod = load();
    await record(mod, { preferred: 'claude-sonnet-5', provider: 'gemini', wireModel: 'gemini-99-imaginary' });
    await record(mod, { preferred: 'claude-opus-5', provider: 'gemini', wireModel: 'gemini-99-imaginary' });
    await record(mod, { preferred: 'claude-sonnet-5', provider: 'openai', wireModel: 'gemini-99-imaginary' });
    expect(warnings()).toHaveLength(2);
  });
});
