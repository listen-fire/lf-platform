import Mailgun, { MailgunMessageData } from 'mailgun.js';
import { IMailgunClient } from 'mailgun.js/Interfaces';
import formData from 'form-data';

import { OutboundEmailMessager, EmailRecipient, SendArgs } from './interface';

const emailAddressAndNameToString = (input: EmailRecipient) => {
  // e.g. Support <support@example.com>, or a bare address with no display name
  return input.username ? `${input.username} <${input.email}>` : input.email;
};

/**
 * Mailgun serves each region from its own endpoint, and an account only exists
 * in one of them. This is the EU one, which is where Listen-Fire's account lives — a
 * REGION is not an identity, so unlike the sending domain it keeps its default:
 * getting it wrong fails at the API call rather than sending mail as us.
 */
const EU_API_BASE_URL = 'https://api.eu.mailgun.net';

class OutboundMailgunAdapter implements OutboundEmailMessager {
  private mg: IMailgunClient;
  private sendingDomain: string;
  private defaultSender: EmailRecipient;
  private archiveBcc: string | undefined;

  constructor({
    mailgunApiKey,
    sendingDomain,
    defaultSender,
    apiBaseUrl = EU_API_BASE_URL,
    archiveBcc,
  }: {
    mailgunApiKey: string;
    sendingDomain: string;
    defaultSender: EmailRecipient;
    apiBaseUrl?: string;
    /** Every outbound message is copied here when set. Absent = no BCC at all. */
    archiveBcc?: string;
  }) {
    if (!mailgunApiKey) {
      throw new Error('MAILGUN_API_KEY is not set');
    }

    // Mailgun sends from a domain the account owns and has verified; ours used
    // to be hardcoded, which meant a deployment that is not Listen-Fire sent (or
    // failed to send) as Listen-Fire. There is no default anyone else could use.
    if (!sendingDomain) {
      throw new Error(
        'MAILGUN_SENDING_DOMAIN is not set — it is the verified Mailgun domain this deployment sends from',
      );
    }

    if (!defaultSender?.email) {
      throw new Error(
        'OUTBOUND_EMAIL_FROM is not set — it is the address this deployment sends mail as',
      );
    }

    const mailgun = new Mailgun(formData);
    this.mg = mailgun.client({
      username: 'api',
      url: apiBaseUrl,
      key: mailgunApiKey,
    });

    this.sendingDomain = sendingDomain;
    this.defaultSender = defaultSender;
    this.archiveBcc = archiveBcc;
  }

  async send({
    subject,
    data,
    recipients,
    sender = this.defaultSender,
    replyToHeader,
    inReplyToHeader,
    attachment,
    cc,
  }: SendArgs): Promise<boolean> {
    const baseParams = {
      from: emailAddressAndNameToString(sender),
      // Unaddressed replies go back to whoever the mail is FROM. This used to
      // name Listen-Fire's inbox outright, so another deployment's replies came to us.
      'h:Reply-To': replyToHeader ?? emailAddressAndNameToString(sender),
      to: [recipients].flat().map((to) => to.email),
      subject,
      cc: cc ? [cc].flat().map((to) => to.email) : [],
      bcc: this.archiveBcc,
      'h:In-Reply-To': inReplyToHeader ?? undefined,
    };

    let emailContent: MailgunMessageData;
    if (typeof data === 'string' && data.includes('<!DOCTYPE html')) {
      emailContent = {
        ...baseParams,
        html: data,
      };
    } else if (typeof data === 'string') {
      emailContent = {
        ...baseParams,
        text: data,
      };
    } else if (data.templateName) {
      emailContent = {
        ...baseParams,
        template: data.templateName,
        'h:X-Mailgun-Variables': JSON.stringify(data.params),
      };
    } else {
      throw new Error('Unknown data supplied to mailgun function');
    }

    if (attachment) {
      emailContent.attachment = attachment;
    }

    const response = await this.mg.messages.create(this.sendingDomain, emailContent);

    return response.status < 400;
  }
}

export { OutboundMailgunAdapter };
