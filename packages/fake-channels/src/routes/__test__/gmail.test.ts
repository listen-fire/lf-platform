import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { EntityStore } from '../../store';
import { gmailRoutes } from '../gmail';

/**
 * Route-level tests for the fake Gmail's SEND, run via `node --test` (through
 * `tsx --test`, no jest in this package — see package.json).
 *
 * The point of these is that the fake reads a real RFC 2822 message: it is
 * handed one base64url blob and has to find the subject, the recipients, the
 * body and the reply headers in it. A fake that stored the blob and answered
 * questions about the request instead would pass while the adapter's MIME
 * builder produced something no mail client could read.
 */

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-')),
    'fake-channels.db',
  );
  const store = new EntityStore(dbPath);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', gmailRoutes(store));

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const CRLF = '\r\n';

function raw(lines: string[]): string {
  return Buffer.from(lines.join(CRLF), 'utf8').toString('base64url');
}

async function send(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/gmail/v1/users/me/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function state(baseUrl: string): Promise<{
  messages: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
}> {
  const res = await fetch(`${baseUrl}/fake-gmail/state`);
  return (await res.json()) as { messages: Record<string, unknown>[]; outbox: Record<string, unknown>[] };
}

test('gmail send: a plain message lands in the outbox with its headers read back', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { json } = await send(baseUrl, {
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Cc: books@example.com',
        'Subject: Quarterly figures',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Attached, as promised.', 'utf8').toString('base64'),
      ]),
    });
    assert.equal(typeof json.id, 'string');
    assert.equal(json.threadId, json.id, 'new mail starts its own conversation');
    assert.deepEqual(json.labelIds, ['SENT']);

    const { outbox } = await state(baseUrl);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].subject, 'Quarterly figures');
    assert.equal(outbox[0].to, 'rita@northwind.example');
    assert.equal(outbox[0].cc, 'books@example.com');
    assert.equal(outbox[0].body, 'Attached, as promised.');
    assert.equal(outbox[0].inReplyTo, null);
  } finally {
    await close();
  }
});

test('gmail send: a reply keeps the thread it was given and its reply headers', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { json } = await send(baseUrl, {
      threadId: 'thread-7',
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Subject: Re: Quarterly figures',
        'In-Reply-To: <parent@northwind.example>',
        'References: <first@northwind.example> <parent@northwind.example>',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Got it.', 'utf8').toString('base64'),
      ]),
    });
    assert.equal(json.threadId, 'thread-7');

    const { outbox } = await state(baseUrl);
    assert.equal(outbox[0].threadId, 'thread-7');
    assert.equal(outbox[0].inReplyTo, '<parent@northwind.example>');
    assert.equal(outbox[0].references, '<first@northwind.example> <parent@northwind.example>');
    assert.equal(outbox[0].subject, 'Re: Quarterly figures');
  } finally {
    await close();
  }
});

test('gmail send: a multipart message yields its text body and its files', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    await send(baseUrl, {
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Subject: With a file',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="B2"',
        '',
        '--B2',
        'Content-Type: multipart/alternative; boundary="B1"',
        '',
        '--B1',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Plain words.', 'utf8').toString('base64'),
        '--B1',
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('<p>Rich words.</p>', 'utf8').toString('base64'),
        '--B1--',
        '--B2',
        'Content-Type: text/csv; name="figures.csv"',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="figures.csv"',
        '',
        Buffer.from('period,revenue', 'utf8').toString('base64'),
        '--B2--',
      ]),
    });

    const { outbox } = await state(baseUrl);
    assert.equal(outbox[0].body, 'Plain words.');
    assert.deepEqual(outbox[0].attachments, [`${outbox[0].id}-att-1`]);
  } finally {
    await close();
  }
});

test('gmail send: sent mail reads back by id and never shows up as inbox mail', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { json } = await send(baseUrl, {
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Subject: Readable back',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Hello.', 'utf8').toString('base64'),
      ]),
    });

    const fetched = await fetch(`${baseUrl}/gmail/v1/users/me/messages/${String(json.id)}`);
    const message = (await fetched.json()) as { id: string; labelIds: string[] };
    assert.equal(message.id, json.id);
    assert.deepEqual(message.labelIds, ['SENT']);

    // The INBOX-scoped poll must never deliver the mailbox its own outgoing mail.
    const history = await fetch(
      `${baseUrl}/gmail/v1/users/me/history?startHistoryId=1&labelId=INBOX`,
    );
    const page = (await history.json()) as { history: unknown[] };
    assert.deepEqual(page.history, []);

    const { messages } = await state(baseUrl);
    assert.deepEqual(messages, []);
  } finally {
    await close();
  }
});

test('gmail send: a request with no message is refused', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { status } = await send(baseUrl, {});
    assert.equal(status, 400);
  } finally {
    await close();
  }
});

test("gmail list: an unsupported search is refused with a 400 naming it, not matched to nothing", async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/gmail/v1/users/me/messages?q=${encodeURIComponent("larger:5M")}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /unsupported operator "larger:"/);
  } finally {
    await close();
  }
});
