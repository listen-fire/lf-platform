// A tapped callback button arrives as one row of the `whatsapp_message` kind. A fire
// that fails must not be lost: the row throws and retries, and the person is told
// when the row gives up. Only the courtesy reply may fail quietly.

const answerCallbackTap = jest.fn();
jest.mock('../../movement_engine/callback_fire', () => ({
  answerCallbackTap: (...args: unknown[]) => answerCallbackTap(...args),
}));
const sendTextMessage = jest.fn();
jest.mock('../metaApi', () => ({
  getMetaWhatsappApi: () => ({ sendTextMessage: (...args: unknown[]) => sendTextMessage(...args) }),
}));
jest.mock('../dispatch', () => ({ dispatchWhatsappMessage: jest.fn(async () => {}) }));
jest.mock('../utils', () => ({ resolveWhatsappSender: jest.fn(async () => ({ teamId: 'team', displayName: 'Ada' })) }));
jest.mock('../../../lib/slack', () => ({ sendSlackNotification: jest.fn(async () => {}) }));

import { whatsappMessageHandler } from '../inbound_message';

const row = {
  announce: false,
  businessPhoneNumberId: 'PN_1',
  message: {
    from: '15551234567',
    id: 'wamid.TAP',
    timestamp: '1700000000',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'cb_abc', title: 'Ship it' } },
  },
};

const run = (attempts: number) => whatsappMessageHandler.run(row, { attempts, now: new Date() } as never);

beforeEach(() => {
  jest.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
});

describe('a tapped callback button on WhatsApp', () => {
  it('a fire that fails throws, so the row retries, and tells nobody it worked', async () => {
    answerCallbackTap.mockRejectedValue(new Error('the database dropped the connection'));
    await expect(run(1)).rejects.toThrow('the database dropped the connection');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('a row that gives up tells the person, rather than losing the tap in silence', async () => {
    answerCallbackTap.mockRejectedValue(new Error('the database dropped the connection'));
    await expect(run(10)).resolves.toBeUndefined();
    expect(sendTextMessage).toHaveBeenCalledWith('15551234567', 'Something went wrong recording that.', { replyToMessageId: 'wamid.TAP' });
  });

  it('a row that gives up on its delivery\'s first message still tells ops', async () => {
    answerCallbackTap.mockRejectedValue(new Error('the database dropped the connection'));
    const { sendSlackNotification } = jest.requireMock('../../../lib/slack') as { sendSlackNotification: jest.Mock };
    await expect(whatsappMessageHandler.run({ ...row, announce: true }, { attempts: 10, now: new Date() } as never)).resolves.toBeUndefined();
    expect(sendSlackNotification).toHaveBeenCalledTimes(1);
  });

  it('a fire that lands is told as it came out; a failed reply does not run it again', async () => {
    answerCallbackTap.mockResolvedValue({ text: 'Thanks — that has been recorded.', served: true, outcome: 'recorded' });
    sendTextMessage.mockRejectedValue(new Error('Meta is down'));
    await expect(run(1)).resolves.toBeUndefined();
    expect(answerCallbackTap).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith('15551234567', 'Thanks — that has been recorded.', { replyToMessageId: 'wamid.TAP' });
  });
});
