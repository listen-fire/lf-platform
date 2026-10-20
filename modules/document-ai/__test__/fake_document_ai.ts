// A fake Google Document AI for the module's tests: a local HTTP server
// answering the REST API the real client speaks (`google-gax`'s REST mode,
// reached through the module's `base_url`), so what reaches it is the wire
// request a real processor would get.
//
// - `POST /v1/projects/<p>/locations/<l>/processors/<id>:process`: the
//   document's pages, one paragraph each, each page's text `PAGE <n> TEXT`
//   (or the text `texts` names). A PDF's pages are counted in its bytes
//   (`/Type /Page`); an image is one page.
// - The batch path, on the same server: Cloud Storage's JSON API (a resumable
//   upload, listing, download, delete; the client sends no credential to an
//   endpoint of its own), `:batchProcess` writing the processed document to
//   the output prefix as two shards, and the long-running operation it
//   answers, done at its first poll.

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface FakeDocumentAi {
  url: string;
  received: Received[];
  /** The bucket's objects, by name: what is left once a read is done. */
  objects: Map<string, Buffer>;
  close(): Promise<void>;
}

export const pageText = (n: number) => `PAGE ${n} TEXT`;

function field(value: unknown, ...path: string[]): unknown {
  let at: unknown = value;
  for (const key of path) at = at !== null && typeof at === 'object' ? Reflect.get(at, key) : undefined;
  return at;
}

/** A processed document as Document AI writes it: one text, each page's
 *  paragraphs anchored into it (the first page's start left out, as Google does). */
function documentOf(texts: readonly string[]): Record<string, unknown> {
  let text = '';
  const pages = texts.map((page, index) => {
    const start = text.length;
    text += `${page}\n`;
    const segment = { ...(start > 0 ? { startIndex: String(start) } : {}), endIndex: String(text.length) };
    return { pageNumber: index + 1, paragraphs: [{ layout: { textAnchor: { textSegments: [segment] } } }] };
  });
  return { text, pages };
}

function pagesIn(content: Buffer, mimeType: string): number {
  if (mimeType !== 'application/pdf') return 1;
  return content.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
}

const CRC32C_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** An object's hashes as Cloud Storage reports them, which the client checks an upload against. */
function hashes(bytes: Buffer): { md5Hash: string; crc32c: string } {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC32C_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return { md5Hash: createHash('md5').update(bytes).digest('base64'), crc32c: crc.toString('base64') };
}

/** The processed document split into shards, as a batch writes it: the
 *  first page in one, the rest in the other. */
function shards(texts: readonly string[]): Record<string, unknown>[] {
  return texts.length < 2 ? [documentOf(texts)] : [documentOf(texts.slice(0, 1)), documentOf(texts.slice(1))];
}

export async function fakeDocumentAi(options: { texts?: readonly string[] } = {}): Promise<FakeDocumentAi> {
  const received: Received[] = [];
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, string>();
  let url = '';
  const textsOf = (content: Buffer, mimeType: string) => Array.from({ length: pagesIn(content, mimeType) }, (_, i) => options.texts?.[i] ?? pageText(i + 1));
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const path = request.url ?? '/';
      const at = new URL(path, 'http://fake');
      const json = (request.headers['content-type'] ?? '').includes('json') && bytes.length > 0;
      const body: Record<string, unknown> = json ? JSON.parse(bytes.toString('utf8')) : {};
      received.push({ path, headers: request.headers, body });
      const reply = (status: number, out: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(out === undefined ? '' : JSON.stringify(out));
      };
      const method = request.method ?? 'GET';
      let match: RegExpMatchArray | null;
      if (method === 'POST' && /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/processors\/[^/:]+:process$/.test(at.pathname)) {
        const content = Buffer.from(String(field(body, 'rawDocument', 'content') ?? ''), 'base64');
        return reply(200, { document: documentOf(textsOf(content, String(field(body, 'rawDocument', 'mimeType')))) });
      }
      if (method === 'POST' && (match = at.pathname.match(/^\/v1\/(projects\/[^/]+\/locations\/[^/]+)\/processors\/[^/:]+:batchProcess$/))) {
        const input = String(field(body, 'inputDocuments', 'gcsDocuments', 'documents', '0', 'gcsUri'));
        const mimeType = String(field(body, 'inputDocuments', 'gcsDocuments', 'documents', '0', 'mimeType'));
        const output = String(field(body, 'documentOutputConfig', 'gcsOutputConfig', 'gcsUri'));
        const content = objects.get(input.replace(/^gs:\/\/[^/]+\//, '')) ?? Buffer.alloc(0);
        const prefix = output.replace(/^gs:\/\/[^/]+\//, '');
        shards(textsOf(content, mimeType)).forEach((shard, i) => objects.set(`${prefix}0/doc-${i}.json`, Buffer.from(JSON.stringify(shard))));
        return reply(200, { name: `${match[1]}/operations/1`, done: false });
      }
      if (method === 'GET' && (match = at.pathname.match(/^\/v1\/(projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+)$/))) {
        return reply(200, {
          name: match[1],
          done: true,
          metadata: { '@type': 'type.googleapis.com/google.cloud.documentai.v1.BatchProcessMetadata', state: 'SUCCEEDED' },
          response: { '@type': 'type.googleapis.com/google.cloud.documentai.v1.BatchProcessResponse' },
        });
      }
      if (method === 'POST' && (match = at.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/))) {
        const id = String(uploads.size + 1);
        uploads.set(id, String(at.searchParams.get('name') ?? field(body, 'name')));
        return reply(200, {}, { location: `${url}/upload/storage/v1/b/${match[1]}/o?uploadType=resumable&upload_id=${id}` });
      }
      if (method === 'PUT' && at.pathname.startsWith('/upload/storage/v1/b/')) {
        const name = uploads.get(String(at.searchParams.get('upload_id'))) ?? '';
        objects.set(name, bytes);
        return reply(200, { kind: 'storage#object', name, bucket: 'b', size: String(bytes.length), ...hashes(bytes) });
      }
      if (method === 'GET' && (match = at.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o$/))) {
        const prefix = at.searchParams.get('prefix') ?? '';
        const items = [...objects.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ kind: 'storage#object', name, bucket: match?.[1], size: String(objects.get(name)?.length ?? 0) }));
        return reply(200, { kind: 'storage#objects', items });
      }
      if ((match = at.pathname.match(/^\/(?:download\/)?storage\/v1\/b\/[^/]+\/o\/(.+)$/))) {
        const name = decodeURIComponent(match[1]);
        if (method === 'DELETE') {
          objects.delete(name);
          return reply(204, undefined);
        }
        const object = objects.get(name);
        if (object === undefined) return reply(404, { error: { code: 404, message: `no object ${name}` } });
        if (at.searchParams.get('alt') === 'media') {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          return response.end(object);
        }
        return reply(200, { kind: 'storage#object', name, size: String(object.length) });
      }
      reply(404, { error: { code: 404, message: `no route ${method} ${path}`, status: 'NOT_FOUND' } });
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;
  return {
    url,
    received,
    objects,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
