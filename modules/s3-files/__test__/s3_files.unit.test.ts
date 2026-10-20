// The files slot's module against a fake S3 service: a local HTTP server that
// answers PUT, GET and HEAD of path style object URLs, driven by the real S3
// client, so the requests the module makes (endpoint, path style, key layout,
// content type) are the ones a bucket would receive.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { FILES_METHODS, FilesOpenAnswer, StoredFile } from 'engine-contracts/slots';
import { SlotClient, SlotRefused, commonSlotCases, filesSlotCases, serveSlot, type ServedSlot } from 'module-runtime/module-wire';

import { S3_FILES_MANIFEST, s3FilesAnswer } from '../s3_files';

interface FakeObject {
  body: Buffer;
  contentType: string | undefined;
}

interface FakeS3 {
  endpoint: string;
  objects: Map<string, FakeObject>;
  requests: string[];
  close(): Promise<void>;
}

async function fakeS3(): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>();
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://fake').pathname);
      requests.push(`${request.method} ${path}`);
      const stored = objects.get(path);
      if (request.method === 'PUT') {
        objects.set(path, { body: Buffer.concat(chunks), contentType: request.headers['content-type'] });
        response.writeHead(200, { etag: '"fake"' }).end();
      } else if (stored === undefined) {
        response.writeHead(404, { 'content-type': 'application/xml' });
        response.end(request.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
      } else {
        response.writeHead(200, { 'content-length': stored.body.length, 'content-type': stored.contentType ?? 'application/octet-stream' });
        response.end(request.method === 'HEAD' ? undefined : stored.body);
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

const credentials = { access_key_id: 'test-key', secret_access_key: 'test-secret' };

let s3: FakeS3;
let served: ServedSlot;

function settings(extra: Record<string, string> = {}): Record<string, string> {
  return { bucket: 'docs', region: 'auto', endpoint: s3.endpoint, path_style: 'true', ...credentials, ...extra };
}

beforeEach(async () => {
  s3 = await fakeS3();
  served = await serveSlot({ manifest: S3_FILES_MANIFEST, answer: s3FilesAnswer() });
});

afterEach(async () => {
  await served.close();
  await s3.close();
});

const putBytes = (client: SlotClient, tenant: string, name: string, bytes: Buffer, contentType = 'text/plain') =>
  client.read('files.put', { tenant, name, contentType, bytes: bytes.toString('base64') }, StoredFile);
const put = (client: SlotClient, tenant: string, name: string, text: string) => putBytes(client, tenant, name, Buffer.from(text));

describe('the files slot conformance kit', () => {
  for (const conformance of [...commonSlotCases('files', FILES_METHODS), ...filesSlotCases]) {
    it(conformance.name, async () => {
      await conformance.run(new SlotClient(served.address, settings()));
    });
  }
});

describe('files.put', () => {
  it('stores the bytes under the tenant in the bucket, with the content type, and describes them', async () => {
    const client = new SlotClient(served.address, settings({ key_prefix: '/lf/prod/' }));
    const stored = await put(client, 'team-a', 'note.txt', 'héllo');
    expect(stored).toMatchObject({ __brand: 'FileRef', name: 'note.txt', contentType: 'text/plain', size: Buffer.byteLength('héllo') });
    const { objectUri } = stored.source;
    expect(objectUri).toMatch(/^s3:\/\/docs\/lf\/prod\/team-a\/[0-9a-f-]{36}\/note\.txt$/);
    const object = s3.objects.get(`/docs/${objectUri.slice('s3://docs/'.length)}`);
    expect(object?.body.toString()).toBe('héllo');
    expect(object?.contentType).toBe('text/plain');
  });

  it('makes two documents of two puts of one name', async () => {
    const client = new SlotClient(served.address, settings());
    await put(client, 'team-a', 'same.txt', 'one');
    await put(client, 'team-a', 'same.txt', 'two');
    expect(s3.objects.size).toBe(2);
  });

  it('keeps a name with slashes or dots as one path segment', async () => {
    const client = new SlotClient(served.address, settings());
    for (const name of ['a/b.txt', '..', '.']) await put(client, 'team-a', name, 'x');
    const keys = [...s3.objects.keys()].map((key) => key.split('/').slice(4));
    expect(keys.map((rest) => rest.length)).toEqual([1, 1, 1]);
    expect(keys.map(([last]) => last)).toEqual(['a_b.txt', 'file', 'file']);
  });

  it('stores empty bytes', async () => {
    const client = new SlotClient(served.address, settings());
    expect((await put(client, 'team-a', 'empty', '')).size).toBe(0);
  });

  it('refuses a request missing its fields', async () => {
    const client = new SlotClient(served.address, settings());
    await expect(client.call('files.put', { tenant: 'team-a' })).rejects.toBeInstanceOf(SlotRefused);
  });
});

describe('files.owns', () => {
  it('is true for the tenant that stored it and false for another', async () => {
    const client = new SlotClient(served.address, settings());
    const { source } = await put(client, 'team-a', 'f.txt', 'x');
    expect(await client.call('files.owns', { objectUri: source.objectUri, tenant: 'team-a' })).toBe(true);
    expect(await client.call('files.owns', { objectUri: source.objectUri, tenant: 'team-b' })).toBe(false);
  });

  it('keeps a tenant whose name starts with another tenant’s apart', async () => {
    const client = new SlotClient(served.address, settings());
    const { source } = await put(client, 'a/b', 'f.txt', 'x');
    expect(await client.call('files.owns', { objectUri: source.objectUri, tenant: 'a' })).toBe(false);
    expect(await client.call('files.owns', { objectUri: source.objectUri, tenant: 'a/b' })).toBe(true);
  });

  it('is false for a handle that is not one of this store’s, without asking the bucket', async () => {
    const client = new SlotClient(served.address, settings());
    const { source } = await put(client, 'team-a', 'f.txt', 'x');
    const uuidFolder = source.objectUri.split('/').slice(-2, -1)[0];
    s3.requests.length = 0;
    for (const objectUri of [
      'nowhere:missing',
      'lf-files:movement-files/team-a/x/f.txt',
      `s3://other-bucket/team-a/${uuidFolder}/f.txt`,
      's3://docs/team-a/../team-a/x/f.txt',
      's3://docs/team-a/f.txt',
      's3://docs/',
    ]) {
      expect(await client.call('files.owns', { objectUri, tenant: 'team-a' })).toBe(false);
    }
    expect(s3.requests).toEqual([]);
  });

  it('is false for a document the bucket does not hold', async () => {
    const client = new SlotClient(served.address, settings());
    expect(await client.call('files.owns', { objectUri: 's3://docs/team-a/0000/gone.txt', tenant: 'team-a' })).toBe(false);
  });

  it('does not own a document stored outside the key prefix', async () => {
    const { source } = await put(new SlotClient(served.address, settings()), 'team-a', 'f.txt', 'x');
    const prefixed = new SlotClient(served.address, settings({ key_prefix: 'lf' }));
    expect(await prefixed.call('files.owns', { objectUri: source.objectUri, tenant: 'team-a' })).toBe(false);
  });
});

describe('files.open', () => {
  it('returns the stored bytes, binary included', async () => {
    const client = new SlotClient(served.address, settings());
    const binary = Buffer.from([0, 255, 1, 254, 128]);
    const stored = await putBytes(client, 'team-a', 'b.bin', binary, 'application/octet-stream');
    const opened = await client.read('files.open', { objectUri: stored.source.objectUri }, FilesOpenAnswer);
    expect(Buffer.from(opened.bytes, 'base64')).toEqual(binary);
  });

  it('is refused for a document never stored, and for a handle that is not this store’s', async () => {
    const client = new SlotClient(served.address, settings());
    await expect(client.call('files.open', { objectUri: 's3://docs/team-a/0000/gone.txt' })).rejects.toBeInstanceOf(SlotRefused);
    await expect(client.call('files.open', { objectUri: 'nowhere:missing' })).rejects.toBeInstanceOf(SlotRefused);
    await expect(client.call('files.open', { objectUri: 's3://other/team-a/0000/gone.txt' })).rejects.toBeInstanceOf(SlotRefused);
  });
});

describe('settings', () => {
  it('names the missing setting', async () => {
    const client = new SlotClient(served.address, { region: 'auto' });
    await expect(put(client, 'team-a', 'f.txt', 'x')).rejects.toThrow(/no `bucket` setting/);
  });

  it('wants both halves of a credential or neither', async () => {
    const client = new SlotClient(served.address, settings({ secret_access_key: '' }));
    await expect(put(client, 'team-a', 'f.txt', 'x')).rejects.toThrow(/both `access_key_id` and `secret_access_key`/);
  });

  it('addresses the bucket in the path when path_style is true', async () => {
    await put(new SlotClient(served.address, settings()), 'team-a', 'f.txt', 'x');
    expect(s3.requests[0]).toMatch(/^PUT \/docs\/team-a\//);
  });
});
