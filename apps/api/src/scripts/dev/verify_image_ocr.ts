/**
 * Runtime verification of reading an image's text, without a dev-loop stack:
 * the platform's real file reader, under the run's meter, over `@listen-fire/ocr-google`'s
 * real client speaking Google's REST API to a local fake Document AI, with real
 * PNG bytes served by a fake owning adapter. Neither Google nor any model is
 * called: the client signs its own token from a key made here.
 *
 *   NODE_ENV=test node -r ts-node/register/transpile-only -r ./src/test/test-env-defaults.ts src/scripts/dev/verify_image_ocr.ts
 *
 * The run-level half (the engine, `extractOne`, the cap) is
 * `services/movement_engine/__test__/image_file_text.unit.test.ts`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';

import { GoogleDocumentAIAdapter } from 'ocr-google';
import { containerAssociation, type Adapter, type FileRef } from 'movement-engine/public/adapter';
import { metered, NO_BUDGET_LIMIT } from 'movement-engine/public/models';

import { services } from '../../adapters/registry';
import { teamOfTenant } from '../../services/translation_graph/movement/tenant';
import { tenantIdOf } from 'engine-contracts';
import { makeFileTextResolver } from '../../services/translation_graph/movement/file_text';
import { inMemoryRawTextStore } from '../../services/translation_graph/movement/raw_text_store';

const WORDS = 'Acme Corp is raising a seed round';

function png(shade: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8;
  const row = Buffer.from([0, shade, shade, shade, shade]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WITH_TEXT = png(10);
const BLANK = png(255);

const seen: Array<{ url: string | undefined; mimeType: unknown }> = [];
const documentAi = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const raw: unknown = Reflect.get(JSON.parse(body), 'rawDocument');
    if (raw === null || typeof raw !== 'object') throw new Error('no rawDocument');
    seen.push({ url: request.url, mimeType: Reflect.get(raw, 'mimeType') });
    const document =
      Reflect.get(raw, 'content') === WITH_TEXT.toString('base64')
        ? { text: WORDS, pages: [{ paragraphs: [{ layout: { textAnchor: { textSegments: [{ endIndex: String(WORDS.length) }] } } }] }] }
        : { pages: [{ pageNumber: 1 }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ document }));
  });
});

const ownerOf = (bytes: Buffer): Adapter => ({
  adapterType: 'slack',
  supportedTriggers: [],
  runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
  listEntryPoints: async () => [],
  describe: async () => null,
  resolveEntity: async () => ({ candidates: [] }),
  getFieldValue: async () => undefined,
  getRelated: async () => [],
  createRecord: async () => ({ adapterType: 'slack', externalId: 'r1', data: {} }),
  updateRecord: async (input) => ({ adapterType: 'slack', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
  deleteRecord: async () => ({}),
  resolveFileRef: async () => ({ stream: Readable.from([bytes]), size: bytes.length }),
});

async function readOne(name: string, bytes: Buffer): Promise<unknown> {
  const file: FileRef = { __brand: 'FileRef', name, contentType: 'image/png', size: bytes.length, source: { adapterType: 'slack', handle: name } };
  const read = makeFileTextResolver(inMemoryRawTextStore(), {
    teamId: teamOfTenant(tenantIdOf('00000000-0000-0000-0000-0000000000c5')),
    resolveOwner: () => ownerOf(bytes),
  });
  return metered({ file, budget: NO_BUDGET_LIMIT }, (input) => read(input));
}

async function main(): Promise<void> {
  await new Promise<void>((listening) => documentAi.listen(0, '127.0.0.1', listening));
  const address = documentAi.address() as AddressInfo;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  services.ocr = new GoogleDocumentAIAdapter({
    privateKey,
    clientEmail: 'ocr@example.iam.gserviceaccount.com',
    projectId: 'p',
    projectLocation: 'eu',
    processorId: 'proc',
    documentAiEndpoint: `http://127.0.0.1:${address.port}`,
  });
  const withText = await readOne('screenshot.png', WITH_TEXT);
  const blank = await readOne('blank.png', BLANK);
  console.log(JSON.stringify({ withText, blank, documentAiSaw: seen }, null, 2));
  documentAi.close();
  process.exit(0);
}

void main();
