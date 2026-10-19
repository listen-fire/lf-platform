// What Resend is actually asked to send, and which adapter a deployment gets.

import { chooseOutboundEmailProvider } from '../send/choose';
import { OutboundResendAdapter } from '../send/resend';

const SENDER = { email: 'notifications@acme.example', username: 'Acme' };

function adapter(overrides: Partial<{ archiveBcc: string }> = {}) {
  return new OutboundResendAdapter({
    resendApiKey: 'key',
    defaultSender: SENDER,
    apiBaseUrl: 'https://resend.test',
    ...overrides,
  });
}

describe('sending through Resend', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  const bodyOfLastCall = (): Record<string, unknown> =>
    JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'e_1' }), { status: 200 }));
  });

  afterEach(() => fetchSpy.mockRestore());

  it('posts one message to the sending endpoint with the key as a bearer token', async () => {
    await adapter().send({
      recipients: [{ email: 'ada@example.com', username: 'Ada' }],
      subject: 'Hello',
      data: 'plain body',
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://resend.test/emails');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer key');
    expect(bodyOfLastCall()).toMatchObject({
      from: 'Acme <notifications@acme.example>',
      to: ['ada@example.com'],
      subject: 'Hello',
      text: 'plain body',
    });
  });

  it('sends HTML as HTML', async () => {
    await adapter().send({
      recipients: [{ email: 'ada@example.com', username: '' }],
      subject: 'Hello',
      data: '<!DOCTYPE html><html><body>hi</body></html>',
    });
    expect(bodyOfLastCall()).toHaveProperty('html');
    expect(bodyOfLastCall()).not.toHaveProperty('text');
  });

  it('replies to the sender unless told otherwise', async () => {
    await adapter().send({
      recipients: [{ email: 'ada@example.com', username: '' }],
      subject: 'Hello',
      data: 'body',
    });
    expect(bodyOfLastCall().reply_to).toBe('Acme <notifications@acme.example>');
  });

  it('carries cc, the archive bcc, the in-reply-to header and an attachment', async () => {
    await adapter({ archiveBcc: 'archive@acme.example' }).send({
      recipients: [{ email: 'ada@example.com', username: '' }],
      cc: [{ email: 'grace@example.com', username: '' }],
      subject: 'Hello',
      data: 'body',
      replyToHeader: 'replies@acme.example',
      inReplyToHeader: '<m-1@example.com>',
      attachment: { filename: 'deck.pdf', data: Buffer.from('bytes') },
    });

    expect(bodyOfLastCall()).toMatchObject({
      cc: ['grace@example.com'],
      bcc: ['archive@acme.example'],
      reply_to: 'replies@acme.example',
      headers: { 'In-Reply-To': '<m-1@example.com>' },
      attachments: [{ filename: 'deck.pdf', content: Buffer.from('bytes').toString('base64') }],
    });
  });

  it('copies nobody when no archive address is configured', async () => {
    await adapter().send({
      recipients: [{ email: 'ada@example.com', username: '' }],
      subject: 'Hello',
      data: 'body',
    });
    expect(bodyOfLastCall()).not.toHaveProperty('bcc');
  });

  it('reports a provider rejection as a failed send', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 422 }));
    const sent = await adapter().send({
      recipients: [{ email: 'ada@example.com', username: '' }],
      subject: 'Hello',
      data: 'body',
    });
    expect(sent).toBe(false);
  });

  it('refuses a template send rather than posting an empty message', async () => {
    await expect(
      adapter().send({
        recipients: [{ email: 'ada@example.com', username: '' }],
        subject: 'Hello',
        data: { templateName: 'welcome', params: {} },
      }),
    ).rejects.toThrow(/no template API/);
  });

  it('will not be built without the address it sends as', () => {
    expect(
      () =>
        new OutboundResendAdapter({
          resendApiKey: 'key',
          defaultSender: { email: '', username: '' },
        }),
    ).toThrow(/OUTBOUND_EMAIL_FROM/);
  });
});

describe('which outbound adapter a deployment gets', () => {
  const production = { NODE_ENV: 'production', OUTBOUND_EMAIL_FROM: 'a@b.com' };

  it('prefers Resend when both are configured', () => {
    expect(
      chooseOutboundEmailProvider({
        ...production,
        RESEND_API_KEY: 'r',
        MAILGUN_API_KEY: 'm',
        MAILGUN_SENDING_DOMAIN: 'mail.b.com',
      } as NodeJS.ProcessEnv),
    ).toBe('resend');
  });

  it('uses Mailgun when only Mailgun is configured', () => {
    expect(
      chooseOutboundEmailProvider({
        ...production,
        MAILGUN_API_KEY: 'm',
        MAILGUN_SENDING_DOMAIN: 'mail.b.com',
      } as NodeJS.ProcessEnv),
    ).toBe('mailgun');
  });

  it('fails loudly rather than quietly when neither is', () => {
    expect(chooseOutboundEmailProvider(production as NodeJS.ProcessEnv)).toBe('unconfigured');
  });

  it('fails loudly when Mailgun has a key but no verified sending domain', () => {
    expect(
      chooseOutboundEmailProvider({
        ...production,
        MAILGUN_API_KEY: 'm',
      } as NodeJS.ProcessEnv),
    ).toBe('unconfigured');
  });

  it('fails loudly when there is no address to send as', () => {
    expect(
      chooseOutboundEmailProvider({
        NODE_ENV: 'production',
        RESEND_API_KEY: 'r',
      } as NodeJS.ProcessEnv),
    ).toBe('unconfigured');
  });

  it('never sends real mail from a developer’s machine, whatever their .env holds', () => {
    expect(
      chooseOutboundEmailProvider({
        NODE_ENV: 'development',
        RESEND_API_KEY: 'r',
        OUTBOUND_EMAIL_FROM: 'a@b.com',
      } as NodeJS.ProcessEnv),
    ).toBe('fake');
  });
});
