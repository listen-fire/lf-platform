import type Anthropic from '@anthropic-ai/sdk';

const finalMessage = jest.fn();
const stream = jest.fn(() => ({ finalMessage }));

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { stream } })),
}));

const inserted: Record<string, unknown>[] = [];
jest.mock('../../../lib/kysely', () => ({
  getQb: () => ({
    insertInto: () => ({
      values: (row: Record<string, unknown>) => ({
        execute: async () => {
          inserted.push(row);
        },
      }),
    }),
  }),
}));

import { platformModelCall } from '../models_door';

const caller = { teamId: 'team-1', adapterType: 'vendor', credentialsId: 'cred-1' };

function reply(inputTokens: number, outputTokens: number): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: 'hello', citations: null }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as Anthropic.Message;
}

beforeEach(() => {
  inserted.length = 0;
  finalMessage.mockReset();
});

describe('the models door records usage', () => {
  it('writes one llm_usage row per answered call, carrying the team, model and tokens', async () => {
    finalMessage.mockResolvedValueOnce(reply(11, 3)).mockResolvedValueOnce(reply(40, 9));

    await platformModelCall({ caller, request: { label: 'first', system: 's', userMessage: 'u' } });
    expect(inserted).toHaveLength(1);
    await platformModelCall({ caller, request: { label: 'second', system: 's', userMessage: 'u' } });

    expect(inserted).toHaveLength(2);
    expect(inserted.map((row) => [row.team_id, row.label, row.input_tokens, row.output_tokens])).toEqual([
      ['team-1', 'first', 11, 3],
      ['team-1', 'second', 40, 9],
    ]);
    for (const row of inserted) {
      expect(row.call_type).toBe('chat');
      expect(typeof row.model).toBe('string');
      // The door's request carries no run, so a call made through it belongs to none.
      expect(row.trigger_run_id).toBeNull();
    }
  });
});
