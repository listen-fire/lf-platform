// An image through the whole path: a run on the Rust engine, the host's billed
// reader (`sharedRunServices`) and the real byte redemption with an adapter
// owning the file, a real PNG. The OCR reader and the model are fakes here;
// `scripts/dev/verify_image_ocr.ts` holds Google's real client to the same PNGs.
//
// What Morning Recap's digest does is here too: an image as the ONLY source of
// `extractOne`, with no text on it.

import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';

import { mockCatalogSnapshot, type InstanceSchema, LANGUAGE_VERSION } from 'movement-lang';
import { spelledFor } from 'legacy-lang/checker/__test__/surface_spelling';

import { tenantIdOf } from 'engine-contracts';
import { positionData } from 'engine-contracts/catalog';
import { containerAssociation, type Adapter, type FileRef } from 'movement-engine/public/adapter';
import { FileOutsideTeamError, withFileOwners } from 'movement-engine/public/files';
import type { LlmCallResult } from 'movement-engine/public/models';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import { credentialIdsFor, makeTestHost } from 'movement-engine/public/testing';
import { runMovement } from '@listen-fire/legacy-engine/dispatch';
import { runFailureCause } from '@listen-fire/legacy-engine/services/movement_engine/run';

import { services } from '../../../adapters/registry';
import { UnconfiguredOcrAdapter } from '../../../adapters/ocr/unconfigured';
import { runPlatformFor } from '../../translation_graph/movement/carried_run';
import { sharedRunServices } from '../../translation_graph/movement/engine_host';
import { NEVER_CANCELLED } from 'movement-engine/public/host';
import { inMemoryRawTextStore } from '../../translation_graph/movement/raw_text_store';
import { teamOfTenant } from '../../translation_graph/movement/tenant';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c4');

/** A real PNG: an 8-bit greyscale picture, every chunk checksummed. */
function realPng(shade: number): Buffer {
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

const PNG_WITH_TEXT = realPng(10);
const PNG_BLANK = realPng(255);
const WORDS = 'Acme is raising a seed round';

/** Document AI's answers for the two pictures, as its client hands them over:
 *  the words for one, and for the picture holding none a page with no text. */
const readMock = jest.fn(async (rs: Readable, _options: { numpages?: number; size: number; mimeType?: string }) => {
  const chunks: Buffer[] = [];
  for await (const chunk of rs) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).equals(PNG_WITH_TEXT) ? { text: WORDS, pages: 1 } : { text: null, pages: 1 };
});

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', shot: 'file', other: 'file' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});
const PRELUDE = ['import { email } from adapters', 'import { dealflow_inbox } from credentials', 'inbox = email(credentials: dealflow_inbox)', ''].join('\n');

function owner(bytes: Buffer): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data: unknown = positionData(position);
      return data !== null && typeof data === 'object' ? Reflect.get(data, fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
    resolveFileRef: async () => ({ stream: Readable.from([bytes]), contentType: 'image/png', size: bytes.length }),
  };
}

const pngFile = (name: string, bytes: Buffer) => ({
  __brand: 'FileRef',
  name,
  contentType: 'image/png',
  size: bytes.length,
  source: { ownerAdapterType: 'email', handle: name },
});

const eventWith = (bytes: Buffer): TriggerEvent => ({
  pipelineInputId: 'pi-image',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'Acme', shot: pngFile('screenshot.png', bytes), other: pngFile('other.png', bytes) },
});

async function run(source: string, bytes: Buffer, reply: unknown, spend: { priorSpentMicrodollars?: number; costCapMicrodollars?: number } = {}) {
  const asked: string[][] = [];
  const shared = sharedRunServices({
    teamId: teamOfTenant(TEAM_ID),
    cancel: NEVER_CANCELLED,
    rawText: inMemoryRawTextStore(),
  });
  const instance = owner(bytes);
  const result = await runMovement({
    source: spelledFor(LANGUAGE_VERSION, PRELUDE + source, catalog),
    event: eventWith(bytes),
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    ...spend,
    host: makeTestHost({
      adapters: { resolve: () => instance },
      llm: {
        client: { call: async (): Promise<LlmCallResult> => ({ parsedJson: reply }) },
        extractCall: {
          call: async (request) => {
            asked.push(request.blocks.map((block) => block.text));
            return { parsedJson: reply, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
          },
        },
      },
      files: {
        resolveFileText: (request) => withFileOwners(() => instance, () => shared.resolveFileText(request)),
      },
    }),
  }).catch((error: unknown) => ({ failed: String(runFailureCause(error)) }));
  return { result, asked };
}

const NAMED = 'node Named: "the company described" {\n  name: <text> "the company"\n}\n';
const EXTRACT_ONE = `${NAMED}movement m(msg: <inbox-[:message]->>) {\n  found = extractOne([msg.\`shot\`], Named)\n}`;
const READ = 'movement m(msg: <inbox-[:message]->>) {\n  t = READ(msg.`shot`)\n}';

describe('an image in a run, through the real reader', () => {
  beforeEach(() => {
    services.ocr = { extractPdf: jest.fn(), read: readMock };
  });

  it('File.read gives the words on it, read as a PNG, and the trace says what it read', async () => {
    const { result } = await run(READ, PNG_WITH_TEXT, {});
    expect(readMock).toHaveBeenCalledWith(expect.any(Readable), { numpages: 1, size: PNG_WITH_TEXT.length, mimeType: 'image/png' });
    expect(result).toMatchObject({
      trace: [{ kind: 'read', name: 'screenshot.png', contentType: 'image/png', chars: WORDS.length }],
      spentBySource: { 'service:google.document_ai': 1500 },
    });
  });

  it('extractOne reads the words on it', async () => {
    const { result, asked } = await run(EXTRACT_ONE, PNG_WITH_TEXT, { record: { name: { value: 'Acme', evidence: { item: 0, quote: 'Acme' } } } });
    expect(asked[0]?.join('\n')).toContain(WORDS);
    expect(result).toMatchObject({ trace: [{ kind: 'extraction', files: [{ name: 'screenshot.png', chars: WORDS.length }] }] });
  });

  it('File.read of a blank image is absent, with the reason on the trace, and the run ends well', async () => {
    const { result } = await run(READ, PNG_BLANK, {});
    expect(result).not.toHaveProperty('failed');
    expect(result).toMatchObject({
      trace: [{ kind: 'read', name: 'screenshot.png', unreadable: 'no_text' }],
      spentBySource: { 'service:google.document_ai': 1500 },
    });
  });

  it('extractOne with a blank image as its ONLY source: unreadable with its reason, the answer absent, and the run ends well', async () => {
    const { result, asked } = await run(EXTRACT_ONE, PNG_BLANK, { record: null });
    expect(result).not.toHaveProperty('failed');
    expect(result).toMatchObject({
      trace: [{ kind: 'extraction', files: [{ name: 'screenshot.png', unreadable: 'no_text' }], emissions: { Named: 0 } }],
    });
    // The engine still asks the model, telling it the file could not be read.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.[0]).toContain('[this file could not be read: no_text]');
  });

  it('extract with a blank image as its only source finds nothing, and the run ends well', async () => {
    const source = `${NAMED}movement m(msg: <inbox-[:message]->>) {\n  found = extract([msg.\`shot\`], Named)\n}`;
    const { result } = await run(source, PNG_BLANK, { records: [] });
    expect(result).not.toHaveProperty('failed');
    expect(result).toMatchObject({ trace: [{ files: [{ unreadable: 'no_text' }], emissions: { Named: 0 } }] });
  });

  // The engine asks the model even when no source could be read, so these two
  // are the model's doing, not the image's. Held here so a change to either is seen.
  it('a model inventing a record from a blank image is believed: the run ends well, and the trace shows the file unreadable beside the record', async () => {
    const { result } = await run(EXTRACT_ONE, PNG_BLANK, { record: { name: { value: 'Invented', evidence: { item: 0, quote: 'not in the source' } } } });
    expect(result).not.toHaveProperty('failed');
    expect(result).toMatchObject({ trace: [{ files: [{ unreadable: 'no_text' }], emissions: { Named: 1 } }] });
  });

  it('a model answering outside the shape twice fails the run, as it does over any source', async () => {
    const { result } = await run(EXTRACT_ONE, PNG_BLANK, { record: [1] });
    expect(result).toMatchObject({ failed: expect.stringContaining('answered with something its shape does not describe, twice') });
  });

  it('a run with no OCR provider ends well too, its trace saying why', async () => {
    services.ocr = new UnconfiguredOcrAdapter();
    const { result } = await run(EXTRACT_ONE, PNG_WITH_TEXT, { record: null });
    expect(result).not.toHaveProperty('failed');
    expect(result).toMatchObject({
      trace: [{ files: [{ unreadable: 'extraction_failed', detail: expect.stringContaining('an image is read by OCR; OCR is not configured') }] }],
    });
  });

  it("counts against the run's cost: a read past the cap is refused before Document AI is asked", async () => {
    const { result } = await run(READ, PNG_WITH_TEXT, {}, { priorSpentMicrodollars: 1000, costCapMicrodollars: 1000 });
    expect(readMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: expect.stringContaining('cap') });
  });

  it("charges a read to the run: a second read past the cap the first took it to is refused", async () => {
    const twice = 'movement m(msg: <inbox-[:message]->>) {\n  a = READ(msg.`shot`)\n  b = READ(msg.`other`)\n}';
    const { result } = await run(twice, PNG_WITH_TEXT, {}, { costCapMicrodollars: 1000 });
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failed: expect.stringContaining('cap') });
  });
});

describe('a run pinned to a carried release stays as it was', () => {
  const file: FileRef = { __brand: 'FileRef', name: 'shot.png', contentType: 'image/png', source: { ownerAdapterType: 'slack', handle: 'F1' } };
  const budget = { remainingMicrodollars: null };

  beforeEach(() => {
    services.ocr = { extractPdf: jest.fn(), read: readMock };
  });

  it("the carried host's reader skips an image unopened, costing nothing", async () => {
    const { files } = runPlatformFor({ teamId: teamOfTenant(TEAM_ID), cancel: NEVER_CANCELLED });
    expect(await files.resolveFileText({ segmentId: 'seg-1', file, budget })).toEqual({
      unreadable: 'unsupported_type',
      detail: 'image/png',
      cost: [],
    });
    expect(readMock).not.toHaveBeenCalled();
  });

  it('why it must: with no file owners, as that host holds none, opening the image fails the run by name', async () => {
    const shared = sharedRunServices({ teamId: teamOfTenant(TEAM_ID), cancel: NEVER_CANCELLED, rawText: inMemoryRawTextStore() });
    await expect(shared.resolveFileText({ segmentId: 'seg-1', file, budget })).rejects.toThrow(FileOutsideTeamError);
  });
});
