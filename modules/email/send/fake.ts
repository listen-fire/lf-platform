// The dev loop's outbox: every send lands in fake-channels' email service,
// where `dev:inspect` reads it back.

import { logger } from 'movement-engine/public/log';
import { OutboundEmailMessager, SendArgs } from './interface';

class FakeOutboundEmailAdapter implements OutboundEmailMessager {
  constructor(private readonly fakeChannelsUrl: string = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556') {}

  async send(args: SendArgs): Promise<boolean> {
    const payload = {
      recipients: args.recipients,
      sender: args.sender,
      cc: args.cc,
      subject: args.subject,
      data: args.data,
      replyToHeader: args.replyToHeader,
      inReplyToHeader: args.inReplyToHeader,
      attachment: args.attachment
        ? { filename: args.attachment.filename, size: args.attachment.data?.length ?? 0 }
        : undefined,
    };

    try {
      const res = await fetch(`${this.fakeChannelsUrl}/email/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        logger.warn(`FakeOutboundEmailAdapter: fake-channels returned ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      // An unreachable outbox is a FAILED send. Reporting success here made the
      // dev loop unable to distinguish "delivered to the fake outbox" from
      // "nothing happened", which is exactly the bug the ledger exists to catch.
      logger.warn(
        `FakeOutboundEmailAdapter: fake-channels unreachable at ${this.fakeChannelsUrl}. ${(err as Error).message}`,
      );
      logger.info(`Email payload (undelivered): ${JSON.stringify(payload)}`);
      return false;
    }
  }
}

export { FakeOutboundEmailAdapter };
