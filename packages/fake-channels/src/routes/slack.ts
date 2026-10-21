import { Router } from 'express';
import express from 'express';
import type { EntityStore } from '../store';

const SVC = 'slack';

// Real `@slack/web-api` WebClient JSON.stringifys every non-string param
// before POSTing as application/x-www-form-urlencoded (see `serializeApiCallData`
// in node_modules/@slack/web-api/dist/WebClient.js) — so on a genuine call
// `blocks` ALWAYS arrives here as a JSON-encoded string, never a live array.
// Parse it back before validating so the array/object-shape check reflects a
// real malformed payload, not an artifact of the wire format. A caller that
// posts JSON directly (application/json, `blocks` already an array) is left
// untouched.
function parseBlocksParam(raw: unknown): { blocks: unknown[] | null; invalid: boolean } {
  if (raw === undefined) return { blocks: null, invalid: false };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { blocks: null, invalid: true };
    }
  }
  if (!Array.isArray(value) || !value.every((b) => typeof b === 'object' && b !== null)) {
    return { blocks: null, invalid: true };
  }
  return { blocks: value, invalid: false };
}

/** A `ts` window bound as a number, or undefined when the caller sent none.
 *  An empty string is "unset", not zero — form encoding turns an omitted
 *  parameter into one. */
function tsBound(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** The bytes of a stored file. An upload writes both a utf-8 `content` and a
 *  base64 copy; a seeded binary (a PDF is not text) carries only the base64. */
function fileBytes(data: Record<string, unknown>): Buffer {
  if (typeof data.content_base64 === 'string') return Buffer.from(data.content_base64, 'base64');
  return Buffer.from(typeof data.content === 'string' ? data.content : '');
}

/** A stored file dressed as Slack's `files.info` payload. The download URL
 *  points back at this server — bytes never ride the API response in real
 *  Slack, and an adapter that expects them to must fail here, not in prod. */
function slackFile(id: string, data: Record<string, unknown>, base: string): Record<string, unknown> {
  const name = String(data.name ?? data.title ?? `${id}.bin`);
  const url = `${base}/slack/files/${id}/download`;
  return {
    id,
    name,
    title: data.title ?? name,
    mimetype: data.mimetype ?? data.content_type ?? 'application/octet-stream',
    filetype: data.filetype ?? String(name.split('.').pop() ?? 'bin'),
    size: fileBytes(data).length,
    url_private: url,
    url_private_download: url,
  };
}

export function slackRoutes(store: EntityStore): Router {
  const r = Router();

  // Slack Web API uses POST for everything and sends form-encoded or JSON
  //
  // PAGINATED, like the real thing: ONE page per call plus a
  // `response_metadata.next_cursor`, and the caller must follow the cursor to
  // see everything. Returning the whole list in one response — which this did —
  // means the harness cannot reproduce the single most common Slack defect
  // ("a channel I know exists isn't listed"), and silently passes an adapter
  // that never paginates at all.
  //
  // Slack caps `limit` at 1000 and applies its own default of 100 when the
  // caller names none; both are modelled, because a caller that forgets `limit`
  // is exactly the bug worth catching.
  r.post('/conversations.list', (req, res) => {
    const all = store.list(SVC, 'channel').map((c) => c.data);
    const requested = Number(req.body.limit);
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 100, 1000);
    const start = Number(req.body.cursor) || 0;
    const page = all.slice(start, start + limit);
    const next = start + limit;
    res.json({
      ok: true,
      channels: page,
      response_metadata: { next_cursor: next < all.length ? String(next) : '' },
    });
  });

  r.post('/conversations.info', (req, res) => {
    const channelId = req.body.channel;
    const channel = store.get(SVC, 'channel', channelId);
    if (!channel) return res.json({ ok: false, error: 'channel_not_found' });
    res.json({ ok: true, channel: { ...channel.data, is_member: true } });
  });

  r.post('/conversations.join', (req, res) => {
    const channelId = req.body.channel;
    const channel = store.get(SVC, 'channel', channelId);
    if (!channel) return res.json({ ok: false, error: 'channel_not_found' });
    res.json({ ok: true });
  });

  r.post('/conversations.members', (req, res) => {
    const channelId = req.body.channel;
    const members = store.list(SVC, `members:${channelId}`);
    res.json({ ok: true, members: members.map((m) => m.id) });
  });

  // WINDOWED and PAGINATED, like the real thing. `oldest`/`latest` are the
  // only filter Slack offers on history, so an adapter that pushes a time
  // bound down is only exercised if the harness honours it — and one that
  // never follows the cursor must be caught here, not in production. Both
  // bounds are EXCLUSIVE unless `inclusive` is set, which is Slack's own rule
  // and the reason a caller widens an inclusive predicate before sending it.
  r.post('/conversations.history', (req, res) => {
    const channelId = req.body.channel;
    const inclusive = req.body.inclusive === true || req.body.inclusive === 'true';
    const oldest = tsBound(req.body.oldest);
    const latest = tsBound(req.body.latest);
    // Real Slack: history returns top-of-channel messages (thread replies
    // appear only under conversations.replies, parents stay in history).
    const messages = store
      .list(SVC, 'message')
      .filter((m) => m.data.channel === channelId)
      .filter((m) => !m.data.thread_ts || m.data.thread_ts === m.data.ts)
      .filter((m) => {
        const ts = Number(m.data.ts);
        if (oldest !== undefined && (inclusive ? ts < oldest : ts <= oldest)) return false;
        if (latest !== undefined && (inclusive ? ts > latest : ts >= latest)) return false;
        return true;
      })
      .sort((a, b) => Number(b.data.ts) - Number(a.data.ts));
    const requested = Number(req.body.limit);
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 100, 1000);
    const start = Number(req.body.cursor) || 0;
    const page = messages.slice(start, start + limit);
    const next = start + limit;
    res.json({
      ok: true,
      messages: page.map((m) => m.data),
      has_more: next < messages.length,
      response_metadata: { next_cursor: next < messages.length ? String(next) : '' },
    });
  });

  r.post('/conversations.replies', (req, res) => {
    const channelId = req.body.channel;
    const rootTs = req.body.ts;
    // Real Slack: the parent message first, then its replies, oldest first.
    const thread = store
      .list(SVC, 'message')
      .filter((m) => m.data.channel === channelId)
      .filter((m) => m.data.ts === rootTs || m.data.thread_ts === rootTs)
      .sort((a, b) => Number(a.data.ts) - Number(b.data.ts));
    const limit = req.body.limit || 100;
    res.json({ ok: true, messages: thread.slice(0, limit).map((m) => m.data) });
  });

  r.post('/users.list', (_req, res) => {
    const users = store.list(SVC, 'user');
    res.json({ ok: true, members: users.map((u) => u.data) });
  });

  r.post('/users.info', (req, res) => {
    const user = store.get(SVC, 'user', req.body.user);
    if (!user) return res.json({ ok: false, error: 'user_not_found' });
    res.json({ ok: true, user: user.data });
  });

  // Real Slack: a reaction lives ON the message (history/replies items carry a
  // `reactions` array), and adding one twice is an ERROR, not a silent second
  // copy — `already_reacted` is the case a caller has to treat as success, so
  // the harness must be able to produce it. Keyed on channel+ts+name, which is
  // exactly what Slack considers "the same reaction by the same reactor".
  r.post('/reactions.add', (req, res) => {
    const { channel, name, timestamp } = req.body;
    const id = `${channel}:${timestamp}:${name}`;
    if (store.get(SVC, 'reaction', id)) {
      return res.json({ ok: false, error: 'already_reacted' });
    }
    store.create(SVC, 'reaction', { channel, name, timestamp, user: 'bot' }, id);
    const message = store.get(SVC, 'message', timestamp);
    if (message) {
      const existing = Array.isArray(message.data.reactions) ? message.data.reactions : [];
      store.update(SVC, 'message', timestamp, {
        reactions: [...existing, { name, users: ['bot'], count: 1 }],
      });
    }
    res.json({ ok: true });
  });

  r.post('/chat.postMessage', (req, res) => {
    // Slack-shaped `invalid_blocks` 400 emulation — top-level `blocks` present
    // but, once parsed, not an array of block objects. Real block-content
    // validation is out of scope (needs real Block Kit rules); this one
    // structural case is what the adapter's own runtime check ALSO rejects,
    // so it exercises the same negative path as a genuine Slack rejection
    // would: `ok:false` + `response_metadata.messages` (Slack always answers
    // 200, the SDK reads `ok` — see WebClient.js `platformErrorFromResult`).
    const { blocks, invalid } = parseBlocksParam(req.body.blocks);
    if (invalid) {
      res.json({
        ok: false,
        error: 'invalid_blocks',
        response_metadata: { messages: ['[ERROR] invalid_blocks: blocks must be an array of block objects'] },
      });
      return;
    }
    const ts = `${Date.now() / 1000}.${Math.random().toString().slice(2, 8)}`;
    store.create(
      SVC,
      'message',
      {
        channel: req.body.channel,
        text: req.body.text,
        blocks,
        thread_ts: req.body.thread_ts || null,
        ts,
        user: 'bot',
        unfurl_links: req.body.unfurl_links,
        unfurl_media: req.body.unfurl_media,
      },
      ts,
    );
    res.json({ ok: true, ts });
  });

  r.post('/chat.update', (req, res) => {
    const ts = req.body.ts;
    const existing = store.get(SVC, 'message', ts);
    if (!existing) return res.json({ ok: false, error: 'message_not_found' });
    const { blocks, invalid } = parseBlocksParam(req.body.blocks);
    if (invalid) {
      res.json({
        ok: false,
        error: 'invalid_blocks',
        response_metadata: { messages: ['[ERROR] invalid_blocks: blocks must be an array of block objects'] },
      });
      return;
    }
    store.update(SVC, 'message', ts, {
      text: req.body.text ?? existing.data.text,
      blocks,
    });
    res.json({ ok: true, ts });
  });

  // The interactivity `response_url` sink. Real Slack hands an interaction a
  // one-off webhook URL; the dev loop points it here so the ack roundtrip (edit
  // the message / send an ephemeral) is observable. Keyed by an opaque id so a
  // test can read back exactly what the handler posted.
  r.post('/response/:id', (req, res) => {
    store.create(
      SVC,
      'action_response',
      { id: req.params.id, ...req.body, received_at: Date.now() },
      req.params.id,
    );
    // A `replace_original` ack edits the original message — mirror that so the
    // "buttons replaced by a confirmation" is observable on channel history too.
    if (req.body.replace_original) {
      const original = store.get(SVC, 'message', req.params.id);
      if (original) {
        store.update(SVC, 'message', req.params.id, {
          text: req.body.text ?? original.data.text,
          blocks: req.body.blocks ?? null,
        });
      }
    }
    res.json({ ok: true });
  });

  // Slack never puts file bytes in an API response: `files.info` names an
  // authenticated `url_private_download` and the caller fetches THAT with the
  // bot token. Both halves are modelled here, because an adapter that forgets
  // the Authorization header is exactly the failure worth catching in the loop.
  r.post('/files.info', (req, res) => {
    const id = String(req.body.file ?? '');
    const file = store.get(SVC, 'file', id);
    if (!file) return res.json({ ok: false, error: 'file_not_found' });
    res.json({ ok: true, file: slackFile(id, file.data, `${req.protocol}://${req.get('host')}`) });
  });

  r.get('/files/:fileId/download', (req, res) => {
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'not_authed' });
    }
    const file = store.get(SVC, 'file', req.params.fileId);
    if (!file) return res.status(404).json({ ok: false, error: 'file_not_found' });
    const bytes = fileBytes(file.data);
    res.setHeader(
      'content-type',
      String(file.data.mimetype ?? file.data.content_type ?? 'application/octet-stream'),
    );
    res.send(bytes);
  });

  r.post('/files.getUploadURLExternal', (req, res) => {
    const fileId = store.nextId(SVC, 'file');
    res.json({
      ok: true,
      upload_url: `http://localhost:5556/slack/upload/${fileId}`,
      file_id: fileId,
    });
  });

  const rawBody = express.raw({ type: '*/*', limit: '50mb' });

  r.post('/upload/:fileId', rawBody, (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    store.create(SVC, 'file', {
      file_id: req.params.fileId,
      uploaded: true,
      content: raw.toString('utf-8'),
      content_base64: raw.toString('base64'),
      content_type: contentType,
    }, req.params.fileId);
    res.json({ ok: true });
  });

  r.put('/upload/:fileId', rawBody, (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    store.create(SVC, 'file', {
      file_id: req.params.fileId,
      uploaded: true,
      content: raw.toString('utf-8'),
      content_base64: raw.toString('base64'),
      content_type: contentType,
    }, req.params.fileId);
    res.json({ ok: true });
  });

  r.post('/files.completeUploadExternal', (req, res) => {
    // Slack WebClient may send `files` as a JSON-stringified string (form-urlencoded)
    let files = req.body.files || [];
    if (typeof files === 'string') {
      try { files = JSON.parse(files); } catch { files = []; }
    }
    for (const file of files) {
      store.update(SVC, 'file', file.id, {
        completed: true,
        channel_id: req.body.channel_id,
        thread_ts: req.body.thread_ts,
        title: file.title,
      });
    }
    // Real Slack: a completed upload IS a message — the file share posts a
    // message (with `initial_comment` as its text) into the channel/thread.
    // Materialise it so the e2e can observe the caption on channel history.
    if (req.body.channel_id) {
      const ts = `${Date.now() / 1000}.${Math.random().toString().slice(2, 8)}`;
      store.create(
        SVC,
        'message',
        {
          channel: req.body.channel_id,
          text: req.body.initial_comment || null,
          thread_ts: req.body.thread_ts || null,
          files: files.map((f: { id: string }) => f.id),
          ts,
          user: 'bot',
        },
        ts,
      );
    }
    res.json({ ok: true });
  });

  return r;
}
