// What this adapter must NOT do is name Listen-Fire. A deployment that is not ours
// sends as itself, copies its archive to its own inbox (or to none), and takes
// its own replies — none of which used to be true.

const messagesCreate = jest.fn(async (_domain: string, _message: Record<string, unknown>) => ({
  status: 200,
}));
const clientOptions = jest.fn();

jest.mock('mailgun.js', () => ({
  __esModule: true,
  default: class {
    client(options: unknown) {
      clientOptions(options);
      return { messages: { create: messagesCreate } };
    }
  },
}));
jest.mock('form-data', () => ({ __esModule: true, default: class {} }));

import { OutboundMailgunAdapter } from '../send/mailgun';

const config = {
  mailgunApiKey: 'key',
  sendingDomain: 'mg.example.com',
  defaultSender: { email: 'hello@example.com', username: 'Example' },
};

const send = () =>
  ({ recipients: [{ email: 'ada@example.com', username: 'Ada' }], subject: 's', data: 'body' });

const lastCall = () => messagesCreate.mock.calls.at(-1)!;
const lastMessage = () => lastCall()[1];

beforeEach(() => {
  messagesCreate.mockClear();
  clientOptions.mockClear();
});

describe('OutboundMailgunAdapter', () => {
  it('sends from the configured domain with no BCC when none is configured', async () => {
    await new OutboundMailgunAdapter(config).send(send());
    expect(lastCall()[0]).toBe('mg.example.com');
    expect(lastMessage().bcc).toBeUndefined();
  });

  it('copies the archive address only when one is configured', async () => {
    await new OutboundMailgunAdapter({ ...config, archiveBcc: 'archive@example.com' }).send(send());
    expect(lastMessage().bcc).toBe('archive@example.com');
  });

  it('defaults Reply-To to the sender rather than a fixed address', async () => {
    await new OutboundMailgunAdapter(config).send(send());
    expect(lastMessage()['h:Reply-To']).toBe('Example <hello@example.com>');
  });

  it('uses the EU region by default and honours an override', () => {
    new OutboundMailgunAdapter(config);
    expect(clientOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'https://api.eu.mailgun.net' }),
    );

    new OutboundMailgunAdapter({ ...config, apiBaseUrl: 'https://api.mailgun.net' });
    expect(clientOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'https://api.mailgun.net' }),
    );
  });

  it('refuses to construct without the config that has no safe default, naming each var', () => {
    expect(() => new OutboundMailgunAdapter({ ...config, sendingDomain: '' })).toThrow(
      /MAILGUN_SENDING_DOMAIN/,
    );
    expect(
      () => new OutboundMailgunAdapter({ ...config, defaultSender: { email: '', username: '' } }),
    ).toThrow(/OUTBOUND_EMAIL_FROM/);
  });
});
