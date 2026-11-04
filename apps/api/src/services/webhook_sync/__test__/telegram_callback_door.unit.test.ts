// Telegram's door onto the callback router — the branch a button tap takes.
//
// Load-bearing in four separate ways, so all four are pinned:
//   • a tap that is NOT ours must flow on untouched, or the door starts eating
//     other people's buttons (and every non-callback update besides);
//   • recognition order: a callback id first, the legacy ask link after — a
//     re-authored automation and one not yet re-authored must both work;
//   • a tap that IS ours must be acked on EVERY outcome, or the tapper's client
//     spins forever;
//   • the keyboard comes off only when the tap SERVED the message (recorded +
//     single-use) — closed-request-wins means a late tap leaves the message
//     exactly as whoever acted first left it, and a repeatable callback's
//     keyboard is still live.
//
// The responder is a stub: the two Bot API calls are the door's whole contract
// with Telegram, and the adapter's own credential resolution is tested with the
// adapter (adapters/telegram/__test__/telegram.unit.test.ts).

const answerAskByToken = jest.fn();
jest.mock('../../asks/doors', () => ({
  answerAskByToken: (...args: unknown[]) => answerAskByToken(...args),
}));

jest.mock('../../movement_engine/callback_fire', () => ({
  answerCallbackTap: async () => ({ text: 'Ask its owner to upgrade the automation and run it again.', served: true, outcome: 'retired' }),
}));

import { captureEngineLogs } from '../../../test/engine_logs';
import {
  callbackQueryOf,
  handleTelegramCallbackQuery,
  ownsCallbackQuery,
  type TelegramCallbackResponder,
} from '../telegram_callback_door';

const ASK: Record<string, unknown> = { id: 'ask-1' };

function responder() {
  const stub = {
    answerCallbackQuery: jest.fn(async () => {}),
    clearReplyMarkup: jest.fn(async () => {}),
  };
  return stub satisfies TelegramCallbackResponder & Record<string, jest.Mock>;
}

function tapUpdate(data: string, opts?: { withoutMessage?: boolean }) {
  return {
    update_id: 9,
    callback_query: {
      id: 'cbq_1',
      from: { id: 777, is_bot: false, first_name: 'Ada' },
      ...(opts?.withoutMessage
        ? { inline_message_id: 'inline_1' }
        : { message: { message_id: 42, chat: { id: -1001, type: 'supergroup' } } }),
      chat_instance: 'ci_1',
      data,
    },
  };
}

const logs = captureEngineLogs();

beforeEach(() => {
  answerAskByToken.mockReset();
  jest.clearAllMocks();
});

describe('recognising a tap', () => {
  it('reads the callback_query off an update', () => {
    expect(callbackQueryOf(tapUpdate('ask_abc?answer=true'))?.id).toBe('cbq_1');
  });

  it('is null for every other kind of delivery', () => {
    expect(callbackQueryOf({ update_id: 1, message: { message_id: 1 } })).toBeNull();
    expect(callbackQueryOf({})).toBeNull();
    expect(callbackQueryOf(null)).toBeNull();
  });

  it('claims taps whose data is an answer link or a retired callback id, and no others', () => {
    expect(ownsCallbackQuery(tapUpdate('cb_abc'))).toBe(true);
    expect(ownsCallbackQuery(tapUpdate('ask_abc?answer=true'))).toBe(true);
    expect(ownsCallbackQuery(tapUpdate('http://localhost:3500/api/asks/ask_abc?answer=true'))).toBe(true);
    expect(ownsCallbackQuery(tapUpdate('refresh_dashboard'))).toBe(false);
    expect(ownsCallbackQuery({ update_id: 1, message: { message_id: 1 } })).toBe(false);
  });
});

describe('a tap the door does not own flows on untouched', () => {
  it('a plain message update is not handled and nothing is called', async () => {
    const r = responder();
    const result = await handleTelegramCallbackQuery({
      raw: { update_id: 1, message: { message_id: 1, chat: { id: 5 } } },
      responder: r,
    });
    expect(result).toEqual({ handled: false });
    expect(r.answerCallbackQuery).not.toHaveBeenCalled();
    expect(answerAskByToken).not.toHaveBeenCalled();
  });

  it("another bot button's callback_data is not handled — and is NOT acked (it is not ours to ack)", async () => {
    const r = responder();
    expect(await handleTelegramCallbackQuery({ raw: tapUpdate('refresh_dashboard'), responder: r })).toEqual({
      handled: false,
    });
    expect(r.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('a callback_query with no data at all is not handled', async () => {
    const r = responder();
    expect(
      await handleTelegramCallbackQuery({
        raw: { update_id: 1, callback_query: { id: 'cbq_2' } },
        responder: r,
      }),
    ).toEqual({ handled: false });
  });
});

describe('a tap that answers', () => {
  it('resolves through the one answer door, acks, and retires the keyboard', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();

    const result = await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true'),
      responder: r,
    });

    expect(answerAskByToken).toHaveBeenCalledWith('ask_abc', 'true');
    expect(result).toEqual({ handled: true, outcome: 'answered' });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'Thanks — your answer was recorded.',
    });
    expect(r.clearReplyMarkup).toHaveBeenCalledWith({ chatId: '-1001', messageId: 42 });
  });

  it('accepts the full answer URL too (the same link the page uses)', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    await handleTelegramCallbackQuery({
      raw: tapUpdate('http://localhost:3500/api/asks/ask_xyz?answer=Seed'),
      responder: responder(),
    });
    expect(answerAskByToken).toHaveBeenCalledWith('ask_xyz', 'Seed');
  });

  it('url-decodes a multi-word answer', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=option%20two'),
      responder: responder(),
    });
    expect(answerAskByToken).toHaveBeenCalledWith('ask_abc', 'option two');
  });

  it('acks a tap on an inline message it cannot edit, rather than skipping the ack', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();
    await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true', { withoutMessage: true }),
      responder: r,
    });
    expect(r.answerCallbackQuery).toHaveBeenCalled();
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a failed keyboard edit does not undo the answer', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();
    r.clearReplyMarkup.mockRejectedValue(new Error('message is not modified'));

    const result = await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true'),
      responder: r,
    });
    expect(result).toEqual({ handled: true, outcome: 'answered' });
    expect(logs.messages('warn')).toContainEqual(expect.stringContaining('retiring the keyboard failed'));
  });
});

describe('closed-request-wins', () => {
  it('a late tap on a settled question is acked with the notice and KEEPS its keyboard', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'closed', ask: ASK });
    const r = responder();

    const result = await handleTelegramCallbackQuery({
      raw: tapUpdate('ask_abc?answer=true'),
      responder: r,
    });

    expect(result).toEqual({ handled: true, outcome: 'closed' });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'This request was already closed.',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a token this store never minted reads the same way', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'not_ours' });
    const r = responder();
    expect(await handleTelegramCallbackQuery({ raw: tapUpdate('ask_gone?answer=true'), responder: r })).toEqual({
      handled: true,
      outcome: 'not_ours',
    });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'This request was already closed.',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it("an answer the question's type refuses carries the reason back to the tapper", async () => {
    answerAskByToken.mockResolvedValue({ kind: 'invalid', message: 'expected one of: ship, hold', ask: ASK });
    const r = responder();
    await handleTelegramCallbackQuery({ raw: tapUpdate('ask_abc?answer=maybe'), responder: r });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'That answer could not be accepted: expected one of: ship, hold',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });
});

describe('loud, never silent', () => {
  it('an answer-less token in callback_data is logged loudly, acked, and consumed', async () => {
    const r = responder();
    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('ask_bare'), responder: r });

    expect(answerAskByToken).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, outcome: 'malformed' });
    expect(logs.messages('warn')).toContainEqual(expect.stringContaining('no answer'));
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'That button could not be read.',
    });
  });

  it('a thrown resolution is logged and still acked — a spinning client is worse', async () => {
    answerAskByToken.mockRejectedValue(new Error('database is on fire'));
    const r = responder();

    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('ask_abc?answer=true'), responder: r });

    expect(result.handled).toBe(true);
    expect(logs.error()).not.toHaveLength(0);
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: 'cbq_1',
      text: 'Something went wrong recording that answer.',
    });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it('a failed ack is warned about, not thrown', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: ASK });
    const r = responder();
    r.answerCallbackQuery.mockRejectedValue(new Error('query is too old'));

    await expect(
      handleTelegramCallbackQuery({ raw: tapUpdate('ask_abc?answer=true'), responder: r }),
    ).resolves.toEqual({ handled: true, outcome: 'answered' });
    expect(logs.messages('warn')).toContainEqual(expect.stringContaining('answerCallbackQuery failed'));
  });
});

describe('a tap on a callback button an automation wired before 0.13', () => {
  it('is ours: the tapper is told it was retired, and its keyboard comes off', async () => {
    const r = responder();
    expect(ownsCallbackQuery(tapUpdate('cb_abc'))).toBe(true);

    const result = await handleTelegramCallbackQuery({ raw: tapUpdate('cb_abc'), responder: r });

    expect(result).toEqual({ handled: true, outcome: 'retired' });
    expect(answerAskByToken).not.toHaveBeenCalled();
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({ callbackQueryId: 'cbq_1', text: expect.stringContaining('upgrade the automation') });
    expect(r.clearReplyMarkup).toHaveBeenCalledWith({ chatId: '-1001', messageId: 42 });
  });
});
