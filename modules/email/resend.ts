// Resend's receiving API — the second half of an inbound Resend delivery.
//
// Resend's webhook is a NOTIFICATION, not the message: it carries the ids, the
// envelope and the attachment names, and nothing else. No body, no headers, no
// bytes. So everything an author actually reads off an email is fetched here,
// with the API key, after the webhook has been believed.
//
// Attachment bytes are a second peculiarity. Resend hands out a `download_url`
// that expires in an hour, which is far shorter than the life of a stored
// trigger event — a replay the next morning would fetch a dead link. So the
// handle we store is the pair of ids (`resend:<emailId>/<attachmentId>`) and
// the URL is minted fresh at the moment the bytes are wanted.
//
// What reaching the API takes (the key, where, the fetch) is the caller's: the
// platform's from its environment, a module host's from the install's
// credential.

const DEFAULT_API_BASE_URL = 'https://api.resend.com';

/** What one call to Resend's receiving API takes. */
interface ResendApi {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
}

/** Resend paginates the attachment listing; this is its ceiling. */
const ATTACHMENT_PAGE_LIMIT = 100;

interface ResendAttachment {
  id: string;
  filename: string;
  content_type?: string;
  content_disposition?: string;
  content_id?: string;
  size?: number;
  download_url?: string;
}

interface ResendReceivedEmail {
  id: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  received_for?: string[];
  subject?: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  message_id?: string;
  attachments?: ResendAttachment[];
}

async function getJson(api: ResendApi, path: string): Promise<unknown> {
  const url = `${api.baseUrl}${path}`;
  const res = await api.fetch(url, { headers: { Authorization: `Bearer ${api.apiKey}` } });
  if (!res.ok) {
    throw new Error(`Resend ${path} failed (status ${res.status}).`);
  }
  return res.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as object) }
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Header names to values, dropping anything that is not a plain string. */
function headerMap(value: unknown): Record<string, string> | undefined {
  const raw = asRecord(value);
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') headers[name] = entry;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function readAttachment(value: unknown): ResendAttachment | null {
  const raw = asRecord(value);
  const id = str(raw.id);
  const filename = str(raw.filename);
  if (id === undefined || filename === undefined) return null;
  return {
    id,
    filename,
    ...(str(raw.content_type) !== undefined ? { content_type: str(raw.content_type) } : {}),
    ...(str(raw.content_disposition) !== undefined
      ? { content_disposition: str(raw.content_disposition) }
      : {}),
    ...(str(raw.content_id) !== undefined ? { content_id: str(raw.content_id) } : {}),
    ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
    ...(str(raw.download_url) !== undefined ? { download_url: str(raw.download_url) } : {}),
  };
}

/** The whole message behind a webhook's `email_id`. */
async function fetchReceivedEmail(api: ResendApi, emailId: string): Promise<ResendReceivedEmail> {
  const body = asRecord(await getJson(api, `/emails/receiving/${encodeURIComponent(emailId)}`));
  // Resend answers either the object itself or a `{ data: … }` envelope
  // depending on the endpoint; unwrap once so both read the same.
  const raw = asRecord(body.data ?? body);
  return {
    id: str(raw.id) ?? emailId,
    ...(str(raw.from) !== undefined ? { from: str(raw.from) } : {}),
    ...(strings(raw.to) !== undefined ? { to: strings(raw.to) } : {}),
    ...(strings(raw.cc) !== undefined ? { cc: strings(raw.cc) } : {}),
    ...(strings(raw.bcc) !== undefined ? { bcc: strings(raw.bcc) } : {}),
    ...(strings(raw.reply_to) !== undefined ? { reply_to: strings(raw.reply_to) } : {}),
    ...(strings(raw.received_for) !== undefined
      ? { received_for: strings(raw.received_for) }
      : {}),
    ...(str(raw.subject) !== undefined ? { subject: str(raw.subject) } : {}),
    ...(str(raw.html) !== undefined ? { html: str(raw.html) } : {}),
    ...(str(raw.text) !== undefined ? { text: str(raw.text) } : {}),
    ...(headerMap(raw.headers) !== undefined ? { headers: headerMap(raw.headers) } : {}),
    ...(str(raw.message_id) !== undefined ? { message_id: str(raw.message_id) } : {}),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).flatMap((entry) => {
      const attachment = readAttachment(entry);
      return attachment === null ? [] : [attachment];
    }),
  };
}

/** Every attachment on a received message, following the pages to the end. */
async function listReceivedAttachments(api: ResendApi, emailId: string): Promise<ResendAttachment[]> {
  const attachments: ResendAttachment[] = [];
  let after: string | undefined;
  // Bounded by the page ceiling so a provider that never stops handing back a
  // cursor cannot spin here forever.
  for (let page = 0; page < ATTACHMENT_PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({ limit: String(ATTACHMENT_PAGE_LIMIT) });
    if (after !== undefined) query.set('after', after);
    const body = asRecord(
      await getJson(
        api,
        `/emails/receiving/${encodeURIComponent(emailId)}/attachments?${query.toString()}`,
      ),
    );
    const data = Array.isArray(body.data) ? body.data : [];
    for (const entry of data) {
      const attachment = readAttachment(entry);
      if (attachment !== null) attachments.push(attachment);
    }
    const cursor = attachments[attachments.length - 1]?.id;
    if (body.has_more !== true || cursor === undefined) break;
    after = cursor;
  }
  return attachments;
}

/** The handle an email attachment is stored under. Not a URL — Resend's URLs
 *  expire in an hour, so what persists is the pair of ids they are minted from. */
function resendAttachmentHandle(emailId: string, attachmentId: string): string {
  return `resend:${emailId}/${attachmentId}`;
}

interface ResendAttachmentRef {
  emailId: string;
  attachmentId: string;
}

/** Read a stored handle back into its ids, or null when it is not one of ours. */
function parseResendAttachmentHandle(handle: string): ResendAttachmentRef | null {
  const match = handle.match(/^resend:([^/]+)\/(.+)$/);
  if (match === null) return null;
  return { emailId: match[1], attachmentId: match[2] };
}

/** A LIVE download URL for a stored handle, minted now. */
async function mintAttachmentDownloadUrl(api: ResendApi, ref: ResendAttachmentRef): Promise<string> {
  const attachments = await listReceivedAttachments(api, ref.emailId);
  const match = attachments.find((a) => a.id === ref.attachmentId);
  if (match?.download_url === undefined) {
    throw new Error(
      `Resend no longer lists attachment ${ref.attachmentId} on email ${ref.emailId}.`,
    );
  }
  return match.download_url;
}

export {
  ATTACHMENT_PAGE_LIMIT,
  DEFAULT_API_BASE_URL,
  fetchReceivedEmail,
  listReceivedAttachments,
  mintAttachmentDownloadUrl,
  parseResendAttachmentHandle,
  resendAttachmentHandle,
  type ResendAttachment,
  type ResendApi,
  type ResendAttachmentRef,
  type ResendReceivedEmail,
};
