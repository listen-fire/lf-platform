// Fake Gmail (v1 REST subset) — serves the googleapis client with its rootUrl
// pointed here, so the paths are Gmail's own (/gmail/v1/users/…) and the
// adapter under test is the real one. Mounted at the host ROOT for the same
// reason Drive is: googleapis resolves request paths against the rootUrl
// ORIGIN and drops any path prefix.
//
// Two entity types: one 'message' per message, holding the Gmail WIRE shape
// (id, threadId, labelIds, snippet, internalDate, historyId, payload), and a
// single 'mailbox' row holding the change marker and how far back history
// still reaches. The second is what makes the expired-marker path testable:
// `POST /fake-gmail/expire-history` walks the floor forward, and every
// `history.list` below it then 404s exactly as Gmail's does after a quiet week.
//
// The authoring shape a test writes (`POST /fake-gmail/messages`) is friendly —
// subject, from, body, attachments — and the MIME tree is built HERE, so a
// caller never hand-rolls base64url parts.

import { Router } from 'express';
import type { EntityStore } from '../store';
import { evaluateGmailQuery, GmailQueryError, parseGmailQuery, type QueryTarget } from './gmail_query';

const SVC = 'gmail';
const MAILBOX_ID = 'mailbox';

interface MailboxState {
  emailAddress: string;
  historyId: number;
  /** The oldest marker `history.list` still answers for. Everything below it
   *  has been dropped, which is Gmail's week-of-inactivity behaviour. */
  oldestHistoryId: number;
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function readMailbox(store: EntityStore): MailboxState {
  const row = store.get(SVC, MAILBOX_ID, MAILBOX_ID);
  const data = row?.data ?? {};
  return {
    emailAddress: typeof data.emailAddress === 'string' ? data.emailAddress : 'dev-loop@listen-fire.local',
    historyId: typeof data.historyId === 'number' ? data.historyId : 1000,
    oldestHistoryId: typeof data.oldestHistoryId === 'number' ? data.oldestHistoryId : 1,
  };
}

function writeMailbox(store: EntityStore, state: MailboxState): void {
  const row = { ...state };
  if (store.get(SVC, MAILBOX_ID, MAILBOX_ID)) {
    store.update(SVC, MAILBOX_ID, MAILBOX_ID, row);
  } else {
    store.create(SVC, MAILBOX_ID, row, MAILBOX_ID);
  }
}

interface WireHeader {
  name?: string;
  value?: string;
}

/** The header list off a stored message's payload, narrowed without trusting
 *  the JSON the store round-tripped. */
function headersOf(payload: unknown): WireHeader[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = Reflect.get(payload, 'headers');
  if (!Array.isArray(raw)) return [];
  const headers: WireHeader[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = Reflect.get(entry, 'name');
    const value = Reflect.get(entry, 'value');
    headers.push({
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof value === 'string' ? { value } : {}),
    });
  }
  return headers;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

interface SeedAttachment {
  filename: string;
  contentType?: string;
  content?: string;
}

/** The MIME tree a seeded message gets: multipart/mixed over a
 *  multipart/alternative, so the decode under test walks real nesting rather
 *  than a single flat part. */
function buildPayload(input: {
  subject: string;
  from: string;
  to: string;
  cc?: string;
  date: Date;
  bodyText?: string;
  bodyHtml?: string;
  attachments: SeedAttachment[];
  messageId: string;
  extraHeaders?: WireHeader[];
}): Record<string, unknown> {
  const headers = [
    { name: 'Subject', value: input.subject },
    { name: 'From', value: input.from },
    { name: 'To', value: input.to },
    ...(input.cc ? [{ name: 'Cc', value: input.cc }] : []),
    { name: 'Date', value: input.date.toUTCString() },
    // Real Gmail stamps one on everything it accepts, and it is the only id a
    // reply's In-Reply-To can carry — a fake without it would make the reply
    // path look like it worked while sending a header nobody could follow.
    { name: 'Message-Id', value: `<${input.messageId}@fake-gmail.local>` },
    ...(input.extraHeaders ?? []),
  ];

  const alternatives: Record<string, unknown>[] = [];
  if (input.bodyText !== undefined) {
    alternatives.push({
      partId: '0.0',
      mimeType: 'text/plain',
      filename: '',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
      body: { size: input.bodyText.length, data: b64url(input.bodyText) },
    });
  }
  if (input.bodyHtml !== undefined) {
    alternatives.push({
      partId: '0.1',
      mimeType: 'text/html',
      filename: '',
      headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }],
      body: { size: input.bodyHtml.length, data: b64url(input.bodyHtml) },
    });
  }

  const parts: Record<string, unknown>[] = [
    {
      partId: '0',
      mimeType: 'multipart/alternative',
      filename: '',
      headers: [{ name: 'Content-Type', value: 'multipart/alternative' }],
      body: { size: 0 },
      parts: alternatives,
    },
    ...input.attachments.map((attachment, index) => {
      const content = attachment.content ?? '';
      return {
        partId: String(index + 1),
        mimeType: attachment.contentType ?? 'application/octet-stream',
        filename: attachment.filename,
        headers: [
          { name: 'Content-Disposition', value: `attachment; filename="${attachment.filename}"` },
        ],
        body: {
          attachmentId: `${input.messageId}-att-${index + 1}`,
          size: Buffer.byteLength(content, 'utf8'),
        },
      };
    }),
  ];

  return {
    partId: '',
    mimeType: 'multipart/mixed',
    filename: '',
    headers,
    body: { size: 0 },
    parts,
  };
}

/** The RFC 822 text `format=raw` serves — assembled from the stored tree so
 *  the two formats can never disagree about what the message says. */
function rawOf(message: Record<string, unknown>): string {
  const lines = headersOf(message.payload).map((h) => `${h.name ?? ''}: ${h.value ?? ''}`);
  const body = typeof message.bodyText === 'string' ? message.bodyText : '';
  return b64url(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

function wireMessage(data: Record<string, unknown>): Record<string, unknown> {
  const { bodyText: _bodyText, attachmentContent: _content, ...rest } = data;
  return rest;
}

/** Bare words are matched against the subject, the snippet and the body. */
function queryTargetOf(data: Record<string, unknown>): QueryTarget {
  const headers = new Map<string, string>();
  for (const entry of headersOf(data.payload)) {
    headers.set((entry.name ?? '').toLowerCase(), entry.value ?? '');
  }
  return {
    headers,
    labels: stringsOf(data.labelIds),
    filenames: filenamesOf(data.payload),
    freeText: [
      headers.get('subject') ?? '',
      typeof data.snippet === 'string' ? data.snippet : '',
      typeof data.bodyText === 'string' ? data.bodyText : '',
    ]
      .join('\n')
      .toLowerCase(),
    internalDateMs: Number(data.internalDate ?? 0),
  };
}

function filenamesOf(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const names: string[] = [];
  const filename = Reflect.get(payload, 'filename');
  if (typeof filename === 'string' && filename !== '') names.push(filename);
  const parts = Reflect.get(payload, 'parts');
  if (Array.isArray(parts)) for (const part of parts) names.push(...filenamesOf(part));
  return names;
}

// ── Reading a sent message back ─────────────────────────────────────────────
// `messages.send` hands over ONE base64url blob, so the fake has to parse RFC
// 2822 to know what was sent. That is the point: the outbox only shows a
// subject, a recipient and a body if the adapter's MIME builder really produced
// a message another program can read.

interface ParsedMessage {
  headers: Map<string, string>;
  text?: string;
  html?: string;
  attachments: SeedAttachment[];
}

/** Split a MIME entity into its header block and its body, unfolding headers
 *  that were wrapped across lines (a continuation starts with whitespace). */
function splitEntity(entity: string): { headers: Map<string, string>; body: string } {
  const at = entity.search(/\r?\n\r?\n/);
  const head = at < 0 ? entity : entity.slice(0, at);
  const body = at < 0 ? '' : entity.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers = new Map<string, string>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function decodeBody(body: string, encoding: string): string {
  return encoding.toLowerCase() === 'base64'
    ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
    : body;
}

function filenameOf(headers: Map<string, string>): string | undefined {
  const source = `${headers.get('content-disposition') ?? ''} ${headers.get('content-type') ?? ''}`;
  const match = /(?:file)?name="?([^";]+)"?/i.exec(source);
  return match ? match[1] : undefined;
}

/** Walk one entity, collecting the bodies and the files — the same shape the
 *  real decoder produces, so the outbox and a fetched message agree. */
function collect(entity: string, into: ParsedMessage): void {
  const { headers, body } = splitEntity(entity);
  const contentType = headers.get('content-type') ?? 'text/plain';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const filename = filenameOf(headers);

  if (mime.startsWith('multipart/')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (boundary === undefined) return;
    for (const section of body.split(`--${boundary}`)) {
      const trimmed = section.replace(/^\r?\n/, '');
      if (trimmed.trim() === '' || trimmed.startsWith('--')) continue;
      collect(trimmed, into);
    }
    return;
  }

  const decoded = decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit');
  if (filename !== undefined) {
    into.attachments.push({ filename, contentType: mime, content: decoded });
    return;
  }
  if (mime === 'text/html') into.html = decoded;
  else into.text = decoded;
}

function parseRfc2822(raw: string): ParsedMessage {
  const parsed: ParsedMessage = { headers: splitEntity(raw).headers, attachments: [] };
  collect(raw, parsed);
  return parsed;
}

export function gmailRoutes(store: EntityStore): Router {
  const r = Router();

  r.get('/gmail/v1/users/:userId/profile', (_req, res) => {
    const mailbox = readMailbox(store);
    res.json({
      emailAddress: mailbox.emailAddress,
      messagesTotal: store.list(SVC, 'message').length,
      threadsTotal: store.list(SVC, 'message').length,
      historyId: String(mailbox.historyId),
    });
  });

  r.get('/gmail/v1/users/:userId/messages', (req, res) => {
    const query = String(req.query.q ?? '');
    const max = Number(req.query.maxResults ?? 100);
    const wanted = Array.isArray(req.query.labelIds)
      ? req.query.labelIds.map(String)
      : req.query.labelIds === undefined
        ? []
        : [String(req.query.labelIds)];
    let parsed: ReturnType<typeof parseGmailQuery>;
    try {
      parsed = parseGmailQuery(query);
    } catch (error) {
      if (!(error instanceof GmailQueryError)) throw error;
      console.error(`[fake-gmail] ${error.message}`);
      return res.status(400).json({ error: { code: 400, message: error.message, status: 'INVALID_ARGUMENT' } });
    }
    const now = Date.now();
    const messages = store
      .list(SVC, 'message')
      .map((m) => m.data)
      .filter((data) => evaluateGmailQuery(parsed, queryTargetOf(data), now))
      .filter((data) => wanted.every((label) => stringsOf(data.labelIds).includes(label)))
      .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0))
      .slice(0, Number.isFinite(max) ? max : 100)
      .map((data) => ({ id: String(data.id), threadId: String(data.threadId ?? data.id) }));
    res.json({ messages, resultSizeEstimate: messages.length });
  });

  r.get('/gmail/v1/users/:userId/messages/:id', (req, res) => {
    const row = store.get(SVC, 'message', req.params.id);
    if (!row) return res.status(404).json({ error: { code: 404, message: 'Not Found' } });
    if (String(req.query.format ?? 'full') === 'raw') {
      return res.json({
        id: row.data.id,
        threadId: row.data.threadId,
        labelIds: row.data.labelIds,
        snippet: row.data.snippet,
        historyId: row.data.historyId,
        internalDate: row.data.internalDate,
        raw: rawOf(row.data),
      });
    }
    res.json(wireMessage(row.data));
  });

  /**
   * Send. Gmail takes the whole message as one base64url blob and decides two
   * things: the id, and — given a `threadId` — which conversation it joins. The
   * sent message is stored like any other, labelled SENT, so it reads back by
   * id exactly as the write's handle promises, and the INBOX-scoped poll never
   * delivers the mailbox its own outgoing mail.
   */
  r.post('/gmail/v1/users/:userId/messages/send', (req, res) => {
    const mailbox = readMailbox(store);
    const raw = String(req.body?.raw ?? '');
    if (raw === '') {
      return res.status(400).json({ error: { code: 400, message: 'Missing raw message' } });
    }
    const parsed = parseRfc2822(Buffer.from(raw, 'base64url').toString('utf8'));
    const id = `sent-${store.nextId(SVC, 'message')}`;
    const threadId = req.body?.threadId ? String(req.body.threadId) : id;
    const historyId = mailbox.historyId + 1;
    const date = new Date();

    const replyHeaders: WireHeader[] = [];
    const inReplyTo = parsed.headers.get('in-reply-to');
    const references = parsed.headers.get('references');
    if (inReplyTo) replyHeaders.push({ name: 'In-Reply-To', value: inReplyTo });
    if (references) replyHeaders.push({ name: 'References', value: references });

    const payload = buildPayload({
      subject: parsed.headers.get('subject') ?? '',
      from: parsed.headers.get('from') ?? mailbox.emailAddress,
      to: parsed.headers.get('to') ?? '',
      ...(parsed.headers.get('cc') ? { cc: parsed.headers.get('cc') ?? '' } : {}),
      date,
      ...(parsed.text !== undefined ? { bodyText: parsed.text } : {}),
      ...(parsed.html !== undefined ? { bodyHtml: parsed.html } : {}),
      attachments: parsed.attachments,
      messageId: id,
      extraHeaders: replyHeaders,
    });

    const attachmentContent: Record<string, string> = {};
    parsed.attachments.forEach((attachment, index) => {
      attachmentContent[`${id}-att-${index + 1}`] = attachment.content ?? '';
    });

    store.create(
      SVC,
      'message',
      {
        id,
        threadId,
        labelIds: ['SENT'],
        snippet: (parsed.text ?? parsed.html ?? '').slice(0, 120),
        historyId: String(historyId),
        internalDate: String(date.getTime()),
        sizeEstimate: raw.length,
        payload,
        bodyText: parsed.text ?? '',
        attachmentContent,
      },
      id,
    );
    writeMailbox(store, { ...mailbox, historyId });
    res.json({ id, threadId, labelIds: ['SENT'] });
  });

  r.get('/gmail/v1/users/:userId/messages/:messageId/attachments/:id', (req, res) => {
    const row = store.get(SVC, 'message', req.params.messageId);
    if (!row) return res.status(404).json({ error: { code: 404, message: 'Not Found' } });
    const contents = row.data.attachmentContent;
    const content =
      typeof contents === 'object' && contents !== null
        ? Reflect.get(contents, req.params.id)
        : undefined;
    if (typeof content !== 'string') {
      return res.status(404).json({ error: { code: 404, message: 'Attachment not found' } });
    }
    res.json({ size: Buffer.byteLength(content, 'utf8'), data: Buffer.from(content, 'utf8').toString('base64url') });
  });

  r.get('/gmail/v1/users/:userId/history', (req, res) => {
    const mailbox = readMailbox(store);
    const start = Number(req.query.startHistoryId ?? 0);
    // Gmail's own answer to a marker it has dropped — the poll's resync path.
    if (!Number.isFinite(start) || start < mailbox.oldestHistoryId) {
      return res.status(404).json({
        error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' },
      });
    }
    const labelId = req.query.labelId === undefined ? null : String(req.query.labelId);
    const history = store
      .list(SVC, 'message')
      .map((m) => m.data)
      .filter((data) => Number(data.historyId ?? 0) > start)
      .filter((data) => labelId === null || stringsOf(data.labelIds).includes(labelId))
      .sort((a, b) => Number(a.historyId ?? 0) - Number(b.historyId ?? 0))
      .map((data) => ({
        id: String(data.historyId),
        messagesAdded: [
          { message: { id: String(data.id), threadId: String(data.threadId ?? data.id) } },
        ],
      }));
    res.json({ history, historyId: String(mailbox.historyId) });
  });

  // ── fake Google OAuth ─────────────────────────────────────────────────────
  // Two endpoints, which is all a sign-in is: a consent that redirects back
  // with a code, and a token endpoint that trades the code for tokens. The
  // adapter under test is the REAL OAuth client with its endpoints pointed
  // here, so the code exchange, the granted scopes and the refresh token are
  // all exercised rather than stubbed.
  //
  // The consent never asks anybody anything — there is no account to choose
  // between — so it redirects immediately. The scopes the client asked for are
  // remembered against the code, because what Google GRANTED is the fact the
  // send path later depends on.

  r.get('/fake-google-oauth/auth', (req, res) => {
    const redirectUri = String(req.query.redirect_uri ?? '');
    if (redirectUri === '') return res.status(400).send('Missing redirect_uri');
    const code = `fake-auth-code-${store.nextId(SVC, 'oauth_code')}`;
    store.create(SVC, 'oauth_code', { scope: String(req.query.scope ?? '') }, code);
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', String(req.query.state ?? ''));
    res.redirect(back.toString());
  });

  r.post('/fake-google-oauth/token', (req, res) => {
    const grantType = String(req.body?.grant_type ?? 'authorization_code');
    const mailbox = readMailbox(store);

    if (grantType === 'refresh_token') {
      // A refresh renews the access token and nothing else — the same shape
      // Google answers with, so the rotation listener has something real to
      // write down. A refresh token minted here carries the scopes its original
      // code was granted, which is how a PASTED token proves what it may do.
      const refresh = String(req.body?.refresh_token ?? '');
      const code = refresh.startsWith('fake-refresh-') ? refresh.slice('fake-refresh-'.length) : '';
      const granted = store.get(SVC, 'oauth_code', code);
      if (code !== '' && !granted) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        });
      }
      return res.json({
        access_token: `fake-access-${Date.now()}`,
        expires_in: 3600,
        token_type: 'Bearer',
        scope: String(granted?.data.scope ?? req.body?.scope ?? ''),
      });
    }

    const code = String(req.body?.code ?? '');
    const row = store.get(SVC, 'oauth_code', code);
    if (!row) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown code' });
    }
    res.json({
      access_token: `fake-access-${code}`,
      refresh_token: `fake-refresh-${code}`,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: String(row.data.scope ?? ''),
      // Not read by anything here; present because a real Google response with
      // these scopes carries one, and a fake that omits it invites code that
      // quietly depends on its absence.
      id_token: `fake-id-token-for-${mailbox.emailAddress}`,
    });
  });

  /** What Google's `tokeninfo` says about an access token. Only reached when a
   *  token response carried no `scope` of its own, which this fake's does — it
   *  exists so the fallback path has somewhere real to go. */
  r.get('/fake-google-oauth/tokeninfo', (req, res) => {
    const token = String(req.query.access_token ?? '');
    if (token === '') {
      return res.status(400).json({ error: 'invalid_token' });
    }
    res.json({
      aud: 'fake-google-oauth-client',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      expires_in: 3600,
      email: readMailbox(store).emailAddress,
    });
  });

  /** Mint a refresh token for a given scope set, so a test can paste one
   *  without first driving a consent. Fake-only — there is no such endpoint at
   *  Google, and the token it returns is redeemable only here. */
  r.post('/fake-google-oauth/refresh-tokens', (req, res) => {
    const scope = String(req.body?.scope ?? 'https://www.googleapis.com/auth/gmail.readonly');
    const code = `pasted-${store.nextId(SVC, 'oauth_code')}`;
    store.create(SVC, 'oauth_code', { scope }, code);
    res.json({ refresh_token: `fake-refresh-${code}`, scope });
  });

  // ── fake-only control surface ─────────────────────────────────────────────

  /** Drop a message into the mailbox, built from a friendly shape. */
  r.post('/fake-gmail/messages', (req, res) => {
    const mailbox = readMailbox(store);
    const id = req.body.id ? String(req.body.id) : `msg-${store.nextId(SVC, 'message')}`;
    const historyId = mailbox.historyId + 1;
    const date = req.body.date ? new Date(String(req.body.date)) : new Date();
    const attachments: SeedAttachment[] = Array.isArray(req.body.attachments)
      ? req.body.attachments
      : [];
    const bodyText = req.body.bodyText === undefined ? undefined : String(req.body.bodyText);
    const bodyHtml = req.body.bodyHtml === undefined ? undefined : String(req.body.bodyHtml);

    const payload = buildPayload({
      subject: String(req.body.subject ?? ''),
      from: String(req.body.from ?? 'sender@example.com'),
      to: String(req.body.to ?? mailbox.emailAddress),
      ...(req.body.cc ? { cc: String(req.body.cc) } : {}),
      date,
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(bodyHtml !== undefined ? { bodyHtml } : {}),
      attachments,
      messageId: id,
    });

    const attachmentContent: Record<string, string> = {};
    attachments.forEach((attachment, index) => {
      attachmentContent[`${id}-att-${index + 1}`] = attachment.content ?? '';
    });

    const data: Record<string, unknown> = {
      id,
      threadId: req.body.threadId ? String(req.body.threadId) : id,
      labelIds: Array.isArray(req.body.labelIds) ? stringsOf(req.body.labelIds) : ['INBOX', 'UNREAD'],
      snippet: String(req.body.snippet ?? bodyText ?? '').slice(0, 120),
      historyId: String(historyId),
      internalDate: String(date.getTime()),
      sizeEstimate: 1024,
      payload,
      // Kept beside the wire shape so `format=raw` and the attachment endpoint
      // have something to serve; stripped from every message reply.
      bodyText: bodyText ?? '',
      attachmentContent,
    };
    store.create(SVC, 'message', data, id);
    writeMailbox(store, { ...mailbox, historyId });
    res.json({ id, historyId: String(historyId), internalDate: data.internalDate });
  });

  /** Expire every change marker at or below the mailbox's current one, so the
   *  next `history.list` 404s — the quiet-week behaviour, on demand. */
  r.post('/fake-gmail/expire-history', (_req, res) => {
    const mailbox = readMailbox(store);
    const next = { ...mailbox, oldestHistoryId: mailbox.historyId + 1 };
    writeMailbox(store, next);
    res.json({ ok: true, oldestHistoryId: String(next.oldestHistoryId) });
  });

  /** The mailbox's own state — what `dev:inspect gmail` reads. The outbox is
   *  split out with its headers spelled out, because "did the reply carry the
   *  right thread and the right In-Reply-To" is the whole question a send
   *  proof asks. */
  r.get('/fake-gmail/state', (_req, res) => {
    const rows = store.list(SVC, 'message').map((m) => m.data);
    const isSent = (data: Record<string, unknown>) => stringsOf(data.labelIds).includes('SENT');
    res.json({
      mailbox: readMailbox(store),
      messages: rows
        .filter((data) => !isSent(data))
        .map((data) => ({
          id: data.id,
          historyId: data.historyId,
          internalDate: data.internalDate,
          labelIds: data.labelIds,
          snippet: data.snippet,
        })),
      outbox: rows.filter(isSent).map((data) => {
        const headers = new Map<string, string>();
        for (const entry of headersOf(data.payload)) {
          headers.set((entry.name ?? '').toLowerCase(), entry.value ?? '');
        }
        return {
          id: data.id,
          threadId: data.threadId,
          internalDate: data.internalDate,
          to: headers.get('to') ?? '',
          cc: headers.get('cc') ?? '',
          from: headers.get('from') ?? '',
          subject: headers.get('subject') ?? '',
          inReplyTo: headers.get('in-reply-to') ?? null,
          references: headers.get('references') ?? null,
          body: typeof data.bodyText === 'string' ? data.bodyText : '',
          attachments: Object.keys(
            typeof data.attachmentContent === 'object' && data.attachmentContent !== null
              ? data.attachmentContent
              : {},
          ),
        };
      }),
    });
  });

  return r;
}
