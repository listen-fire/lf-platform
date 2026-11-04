// A tap on a live callback through Telegram's door: the ack goes out on every
// outcome, a failed fire included, and the keyboard comes off only when the tap
// served the message.

const answerCallbackTap = jest.fn();
jest.mock('../../movement_engine/callback_fire', () => ({
  answerCallbackTap: (...args: unknown[]) => answerCallbackTap(...args),
}));

import { handleTelegramCallbackQuery } from '../telegram_callback_door';

const update = {
  update_id: 9,
  callback_query: { id: 'cbq_1', data: 'cb_abc', message: { message_id: 42, chat: { id: -1001 } } },
};

function responder() {
  return { answerCallbackQuery: jest.fn(async () => {}), clearReplyMarkup: jest.fn(async () => {}) };
}

describe("a tap on a callback through Telegram's door", () => {
  it('a fire that throws still acks, with the error text, and leaves the keyboard', async () => {
    answerCallbackTap.mockRejectedValue(new Error('the database dropped the connection'));
    const r = responder();
    await expect(handleTelegramCallbackQuery({ raw: update, responder: r })).resolves.toEqual({ handled: true, outcome: 'not_found' });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({ callbackQueryId: 'cbq_1', text: 'Something went wrong recording that.' });
    expect(r.clearReplyMarkup).not.toHaveBeenCalled();
  });

  it.each([
    ['recorded', true, 1],
    ['closed', false, 0],
  ])('a fire that comes to %s acks its text and reports its outcome', async (outcome, served, cleared) => {
    answerCallbackTap.mockResolvedValue({ text: 'the fire says this', served, outcome });
    const r = responder();
    await expect(handleTelegramCallbackQuery({ raw: update, responder: r })).resolves.toEqual({ handled: true, outcome });
    expect(r.answerCallbackQuery).toHaveBeenCalledWith({ callbackQueryId: 'cbq_1', text: 'the fire says this' });
    expect(r.clearReplyMarkup).toHaveBeenCalledTimes(cleared);
  });
});
