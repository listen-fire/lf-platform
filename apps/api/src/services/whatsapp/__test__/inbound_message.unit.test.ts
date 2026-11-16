// A tapped callback button arrives as one row of the `whatsapp_message` kind.
// Callbacks were retired with 0.13, so the person is told their button was
// retired: after the dispatch, which may fail and retry, and when the row gives
// up. Only the courtesy reply may fail quietly.

const sendTextMessage = jest.fn();
jest.mock('../metaApi', () => ({
  getMetaWhatsappApi: () => ({ sendTextMessage: (...args: unknown[]) => sendTextMessage(...args) }),
}));
const dispatchWhatsappMessage = jest.fn();
jest.mock('../dispatch', () => ({ dispatchWhatsappMessage: (...args: unknown[]) => dispatchWhatsappMessage(...args) }));
jest.mock('../utils', () => ({ resolveWhatsappSender: jest.fn(async () => ({ teamId: 'team', displayName: 'Ada' })) }));
jest.mock('../../../lib/slack', () => ({ sendSlackNotification: jest.fn(async () => {}) }));

import { RETIRED_CALLBACK_TEXT } from '../../interaction/retired_callback';
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
  dispatchWhatsappMessage.mockResolvedValue(undefined);
});

describe('a tapped callback button on WhatsApp', () => {
  it('is answered as retired, in a threaded reply', async () => {
    await expect(run(1)).resolves.toBeUndefined();
    expect(sendTextMessage).toHaveBeenCalledWith('15551234567', RETIRED_CALLBACK_TEXT, { replyToMessageId: 'wamid.TAP' });
  });

  it('a dispatch that fails throws, so the row retries, before the person is told anything', async () => {
    dispatchWhatsappMessage.mockRejectedValue(new Error('the database dropped the connection'));
    await expect(run(1)).rejects.toThrow('the database dropped the connection');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('a row that gives up still tells the person, rather than leaving the tap in silence', async () => {
    dispatchWhatsappMessage.mockRejectedValue(new Error('the database dropped the connection'));
    await expect(run(10)).resolves.toBeUndefined();
    expect(sendTextMessage).toHaveBeenCalledWith('15551234567', RETIRED_CALLBACK_TEXT, { replyToMessageId: 'wamid.TAP' });
  });

  it("a row that gives up on its delivery's first message still tells ops", async () => {
    dispatchWhatsappMessage.mockRejectedValue(new Error('the database dropped the connection'));
    const { sendSlackNotification } = jest.requireMock('../../../lib/slack') as { sendSlackNotification: jest.Mock };
    await expect(whatsappMessageHandler.run({ ...row, announce: true }, { attempts: 10, now: new Date() } as never)).resolves.toBeUndefined();
    expect(sendSlackNotification).toHaveBeenCalledTimes(1);
  });

  it('a failed reply does not fail the row', async () => {
    sendTextMessage.mockRejectedValue(new Error('Meta is down'));
    await expect(run(1)).resolves.toBeUndefined();
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });
});
