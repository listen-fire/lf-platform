// A 0.12 run reading a file a connected system owns, as production's 0.12.13
// reads it: through the instance the run holds, in 0.12's own module. Real
// Postgres, the real queued run (`run_carried`), 0.12's real run host and its
// real Slack and Gmail modules against fake-channels; the platform's real byte
// reader, billing and raw text store.
//
// Fake here: the PDF parser (unpdf's bundle is ESM, which jest's vm cannot
// load; it still receives the real bytes), OCR, speech to text, and the model.
// Nothing here reaches anything but loopback.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const mockFakeChannels = { url: '' };

jest.mock('../../../../lib/recording', () => {
  const actual = jest.requireActual('../../../../lib/recording');
  return {
    ...actual,
    // The fake's port is chosen when it starts, after this module has loaded.
    injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) => {
      const redirected = actual.injectFakeBaseUrl(creds, service);
      return typeof redirected.baseUrl === 'string'
        ? { ...redirected, baseUrl: `${mockFakeChannels.url}${new URL(redirected.baseUrl).pathname.replace(/\/$/, '')}` }
        : redirected;
    },
  };
});

/** What the fake parser finds in a PDF: the text jsPDF wrote into its pages. */
function mockTextLayerOf(bytes: Uint8Array): string {
  const content = Buffer.from(bytes).toString('latin1');
  return [...content.matchAll(/\((.*?)\) Tj/g)].map((match) => match[1]).join('\n');
}

jest.mock('unpdf', () => ({
  extractText: async (bytes: Uint8Array) => ({ totalPages: 1, text: mockTextLayerOf(bytes) }),
}));

const mockSpeech = jest.fn();
jest.mock('../../../../lib/models/transcription', () => ({
  transcribe: (...args: unknown[]) => mockSpeech(...args),
}));

/** The model answers an extraction with the sources it was handed. */
jest.mock('../llm_clients', () => ({
  ...jest.requireActual('../llm_clients'),
  makeAnthropicExtractCallClient: () => ({
    call: async (request: { blocks: { text: string }[] }) => ({
      parsedJson: { record: { items: { evidence: 'q', value: request.blocks.map((block) => block.text).join(' | ') } } },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  }),
}));

import { z } from 'zod';
import { jsPDF } from 'jspdf';
import type { FileRef } from 'movement-engine/public/adapter';
import { FileOutsideTeamError } from 'movement-engine/public/files';
import { NEVER_CANCELLED } from 'movement-engine/public/host';
import { reportRunCost } from 'movement-engine/public/models';

import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { services } from '../../../../adapters/registry';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { encryptToken } from '../../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { currentLlmUsageContext } from '../../../../lib/llm_usage';
import { testHarnessConfig } from '../../../../lib/recording';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { testWorkContext } from '../../../../test/harness/work';
import { GMAIL_APP_ID, defaultAppIdForType } from '../../../credentials/app_id';
import { runPlatformFor } from '../carried_run';
import { carriedRunHandler } from '../carried_run_now';
import { useDocumentOwnership } from '../../engine/files/retrieve';
import { mintMovementVersionIfChanged } from '../version_store';

const PIN = '0.12.8';

const SLACK_PRELUDE = `import { slack, manual } from adapters
import { Slack } from credentials
chat = connect slack using Slack
runs = connect manual
`;

const GMAIL_PRELUDE = `import { gmail, slack, manual } from adapters
import { Gmail, Slack } from credentials
mail = connect gmail using Gmail
chat = connect slack using Slack
runs = connect manual
`;

const DIGEST = `node Digest: "this one document, exactly one record" {
  items: <text> "what the document says"
}
`;

/** A movement that walks the Slack channel's files and posts what `each` makes
 *  of `f`, the file's record. */
const overSlackFiles = (each: string) => `${SLACK_PRELUDE}${DIGEST}
function reading(run: <runs-[:Invocation]->>) {
  src = only(chat-[c:Channels WHERE c.Name == "deals"]->)
  if (src == null) { fail("no source channel") }
  dst = only(chat-[d:Channels WHERE d.Name == "out"]->)
  if (dst == null) { fail("no post channel") }
  map(coalesce(src-[m:Messages]->, []), (m) => {
    map(coalesce(m-[f:Files]->, []), (f) => {
      write dst-[:Messages]-> { Message: ${each} }
    })
  })
}
listen to runs {} fire reading
`;

const READ_POSTED = 'coalesce(File.read(f.File), "NOTHING READ")';
const EXTRACT_POSTED = 'coalesce(extractOne([f.File], Digest, { tier: "quick" }).items, "NOTHING EXTRACTED")';

const overGmailAttachments = (each: string) => `${GMAIL_PRELUDE}${DIGEST}
function reading(run: <runs-[:Invocation]->>) {
  dst = only(chat-[d:Channels WHERE d.Name == "out"]->)
  if (dst == null) { fail("no post channel") }
  map(coalesce(mail-[m:Messages]->, []), (m) => {
    map(coalesce(m-[a:Attachments]->, []), (a) => {
      ${each}
    })
  })
}
listen to runs {} fire reading
`;

function textLayerPdf(line: string): Buffer {
  const doc = new jsPDF();
  doc.text(line, 10, 10);
  return Buffer.from(doc.output('arraybuffer'));
}

function scannedPdf(): Buffer {
  return Buffer.from(new jsPDF().output('arraybuffer'));
}

// Past the reader's bar for a real text layer: fifty characters a page.
const PDF_LINE = 'Acme raises a seed round to build grid software for utilities';
const SCAN_WORDS = 'words OCR found on the scan';

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  /** Absent: the provider holds no bytes, so opening the file fails. */
  bytes?: Buffer;
}

async function control(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const response = await fetch(`${mockFakeChannels.url}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
  });
  if (!response.ok) throw new Error(`fake-channels ${path} answered ${response.status}`);
  return response.json();
}

async function seedSlack(files: SlackFile[]): Promise<void> {
  await control('/admin/slack/state', { method: 'DELETE' });
  const channel = (id: string, name: string) => ({ entity_type: 'channel', id, data: { id, name, is_channel: true, is_member: true, is_archived: false } });
  await control('/admin/slack/seed', {
    method: 'POST',
    body: {
      entities: [
        channel('C100', 'deals'),
        channel('C200', 'out'),
        {
          entity_type: 'message',
          id: '1751500000.000100',
          data: {
            channel: 'C100',
            ts: '1751500000.000100',
            user: 'U100',
            text: 'a deal',
            files: files.map((file) => ({ id: file.id, name: file.name, mimetype: file.mimetype, size: file.bytes?.length ?? 1 })),
          },
        },
        ...files.flatMap((file) =>
          file.bytes !== undefined
            ? [{ entity_type: 'file', id: file.id, data: { name: file.name, mimetype: file.mimetype, content_base64: file.bytes.toString('base64') } }]
            : [],
        ),
      ],
    },
  });
}

const stateRowOf = z.object({ channel: z.string().optional(), text: z.string().optional(), content_base64: z.string().optional() });

async function stored(entityType: 'message' | 'file'): Promise<z.infer<typeof stateRowOf>[]> {
  return z.array(stateRowOf).parse(await control(`/admin/slack/${entityType}/state`));
}

/** What the run posted to the out channel, in order. */
async function posted(): Promise<string[]> {
  return (await stored('message')).filter((row) => row.channel === 'C200').map((row) => row.text ?? '');
}

describe('a 0.12 run reads a file a connected system owns (real Postgres, real modules, fake providers)', () => {
  let fake: ChildProcess;
  let teamId: TeamId;
  const ocrPdf = jest.fn();
  const ocrImage = jest.fn();

  const saveCredential = async (input: { name: string; type: ExternalServiceType; payload: object; appId: string | undefined }) => {
    const id = randomUUID() as ExternalServiceCredentialsId;
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id, name: input.name, type: input.type, team_id: teamId, app_id: input.appId, credentials: await encryptToken(JSON.stringify(input.payload), id) } as never)
      .execute();
  };

  /** The source saved at the pin and run once, as Run now queues a run. */
  const run = async (source: string, press: Record<string, unknown> = {}) => {
    const movementId = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: movementId as MovementId, team_id: teamId, name: `reading-${movementId.slice(0, 8)}`, source, description: '', language_version: PIN })
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source, languageVersion: PIN });
    const runId = randomUUID();
    await carriedRunHandler.run(
      {
        teamId,
        movementId,
        movementName: 'reading',
        pin: PIN,
        event: { pipelineInputId: `trigger:${movementId}`, adapterType: 'manual', triggerType: 'webhook', payload: { firedAt: new Date().toISOString(), text: 'go', ...press } },
        runId,
      },
      testWorkContext(),
    );
    const row = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId as TriggerRunId)
      .select(['status', 'failure_reason', 'diagnostics', 'steps'])
      .executeTakeFirstOrThrow();
    return { ...row, runId };
  };

  beforeAll(async () => {
    fake = spawn(process.execPath, [require.resolve('@listen-fire/fake-channels/bin/fake-channels.cjs')], {
      // Its test-harness-data goes where it starts.
      cwd: mkdtempSync(join(tmpdir(), 'fake-channels-')),
      env: { PATH: process.env.PATH, FAKE_CHANNELS_PORT: '0', ...(process.env.NODE_OPTIONS !== undefined ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    mockFakeChannels.url = await new Promise<string>((resolve, reject) => {
      let seen = '';
      fake.once('exit', (code) => reject(new Error(`fake-channels exited with ${code}: ${seen}`)));
      fake.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const started = /running on (http:\/\/localhost:\d+)/.exec(seen);
        if (started?.[1] !== undefined) resolve(started[1]);
      });
    });

    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `carried-files-${teamId.slice(0, 8)}` } as any)
      .execute();
    testHarnessConfig.teamId = teamId;
    await saveCredential({ name: 'Slack', type: ExternalServiceType.SLACK, payload: { accessToken: 'fake-slack-token' }, appId: defaultAppIdForType(ExternalServiceType.SLACK) });
    await saveCredential({
      name: 'Gmail',
      type: ExternalServiceType.GOOGLE_GMAIL,
      payload: { mailbox: 'deals@example.com', accessToken: 'fake-gmail-token', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3_600_000, grantedScopes: [] },
      appId: GMAIL_APP_ID.oauthMailbox,
    });
  }, 60_000);

  afterAll(async () => {
    testHarnessConfig.teamId = null;
    fake.removeAllListeners('exit');
    fake.kill();
    await cleanupTeam(teamId);
  });

  beforeEach(() => {
    ocrPdf.mockReset();
    ocrImage.mockReset();
    mockSpeech.mockReset();
    services.ocr = { extractPdf: ocrPdf, read: ocrImage };
  });

  describe('owned by Slack', () => {
    it('File.read gives a PDF its text layer, through the instance the run holds, and no OCR is asked', async () => {
      await seedSlack([{ id: 'F100', name: 'deck.pdf', mimetype: 'application/pdf', bytes: textLayerPdf(PDF_LINE) }]);
      const settled = await run(overSlackFiles(READ_POSTED));
      expect(settled).toMatchObject({ status: 'success', failure_reason: null });
      expect(await posted()).toEqual([PDF_LINE]);
      expect(ocrPdf).not.toHaveBeenCalled();
    });

    it("extractOne is handed a PDF's text", async () => {
      await seedSlack([{ id: 'F101', name: 'deck.pdf', mimetype: 'application/pdf', bytes: textLayerPdf(PDF_LINE) }]);
      const settled = await run(overSlackFiles(EXTRACT_POSTED));
      expect(settled).toMatchObject({ status: 'success', failure_reason: null });
      expect((await posted()).join()).toContain(PDF_LINE);
    });

    it('a scanned PDF takes the OCR route, for File.read and for extractOne', async () => {
      ocrPdf.mockResolvedValue(SCAN_WORDS);
      await seedSlack([{ id: 'F102', name: 'scan.pdf', mimetype: 'application/pdf', bytes: scannedPdf() }]);
      expect(await run(overSlackFiles(READ_POSTED))).toMatchObject({ status: 'success', failure_reason: null });
      expect(await posted()).toEqual([SCAN_WORDS]);
      expect(ocrPdf).toHaveBeenCalledTimes(1);

      ocrPdf.mockClear();
      await seedSlack([{ id: 'F102', name: 'scan.pdf', mimetype: 'application/pdf', bytes: scannedPdf() }]);
      expect(await run(overSlackFiles(EXTRACT_POSTED))).toMatchObject({ status: 'success', failure_reason: null });
      expect((await posted()).join()).toContain(SCAN_WORDS);
    });

    it('an image stays skipped: unopened, unread, the run goes on', async () => {
      // No bytes behind it: opening it would read as a failed file, not a skip.
      await seedSlack([{ id: 'F103', name: 'shot.png', mimetype: 'image/png' }]);
      const settled = await run(overSlackFiles(READ_POSTED));
      expect(settled).toMatchObject({ status: 'success', failure_reason: null });
      expect(await posted()).toEqual(['NOTHING READ']);
      expect(ocrImage).not.toHaveBeenCalled();

      // An extraction's trace says why, and the model is asked about nothing.
      const extracted = await run(overSlackFiles(EXTRACT_POSTED));
      expect(extracted).toMatchObject({ status: 'success', failure_reason: null });
      expect(JSON.stringify(extracted.steps)).toContain('unsupported_type');
    });

    it('a file that cannot be opened is unreadable, and the run goes on, as production', async () => {
      await seedSlack([{ id: 'F104', name: 'gone.pdf', mimetype: 'application/pdf' }]);
      const settled = await run(overSlackFiles(READ_POSTED));
      expect(settled).toMatchObject({ status: 'success', failure_reason: null });
      expect(await posted()).toEqual(['NOTHING READ']);

      const extracted = await run(overSlackFiles(EXTRACT_POSTED));
      expect(extracted).toMatchObject({ status: 'success', failure_reason: null });
      expect(JSON.stringify(extracted.steps)).toContain('bytes_unavailable');
    });

    it('a read that costs is charged to the run, under its billing context, as production charges it', async () => {
      let billedTo: unknown;
      mockSpeech.mockImplementation(async () => {
        billedTo = currentLlmUsageContext()?.data.triggerRunId;
        reportRunCost({ source: { kind: 'service', name: 'test.speech' }, microdollars: 900 });
        return { text: 'the voice note' };
      });
      await seedSlack([{ id: 'F105', name: 'note.ogg', mimetype: 'audio/ogg', bytes: Buffer.from('fake-audio') }]);
      const settled = await run(overSlackFiles(READ_POSTED));
      expect(settled).toMatchObject({ status: 'success', failure_reason: null });
      expect(await posted()).toEqual(['the voice note']);
      expect(billedTo).toBe(settled.runId);
      expect(settled.diagnostics).toMatchObject({ costMicrodollars: 900, costBySource: { 'service:test.speech': 900 } });
    });

    it('a PDF read is free, as production reads it', async () => {
      await seedSlack([{ id: 'F106', name: 'deck.pdf', mimetype: 'application/pdf', bytes: textLayerPdf(PDF_LINE) }]);
      const settled = await run(overSlackFiles(READ_POSTED));
      expect(settled).toMatchObject({ status: 'success', failure_reason: null });
      expect(settled.diagnostics).not.toHaveProperty('costBySource.service:test.speech');
      expect(mockSpeech).not.toHaveBeenCalled();
    });

    it('a file whose owner the run does not hold is refused by name, never read as merely unreadable', async () => {
      const platform = runPlatformFor({ teamId, cancel: { ...NEVER_CANCELLED, reason: () => null } });
      const file: FileRef = { __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', source: { adapterType: 'slack', handle: 'F107' } };
      const read = platform.withFileOwners(
        () => undefined,
        () => platform.files.resolveFileText({ segmentId: 'segment', file, budget: { remainingMicrodollars: null } }),
      );
      await expect(read).rejects.toThrow(FileOutsideTeamError);
    });
  });

  describe('uploaded with a press', () => {
    it('File.read reads it through the manual instance, out of the document store', async () => {
      const bytes = textLayerPdf(PDF_LINE);
      const objectUri = `mem://${teamId}/deck.pdf`;
      services.document = {
        keyOf: (uri: string) => uri.replace('mem://', ''),
        getFileNodeStream: async () => Object.assign(Readable.from([bytes]), { contentType: 'application/pdf', size: bytes.length }),
      } as never;
      const ownership = useDocumentOwnership(async ({ objectUri: asked, teamId: team }) => asked === objectUri && team === teamId);
      try {
        await seedSlack([]);
        const settled = await run(
          `${SLACK_PRELUDE}
function reading(run: <runs-[:Invocation]->>) {
  dst = only(chat-[d:Channels WHERE d.Name == "out"]->)
  if (dst == null) { fail("no post channel") }
  map(coalesce(run-[f:Files]->, []), (f) => {
    write dst-[:Messages]-> { Message: ${READ_POSTED} }
  })
}
listen to runs {} fire reading
`,
          { files: [{ objectUri, filename: 'deck.pdf', contentType: 'application/pdf', size: bytes.length }] },
        );
        expect(settled).toMatchObject({ status: 'success', failure_reason: null });
        expect(await posted()).toEqual([PDF_LINE]);
      } finally {
        useDocumentOwnership(ownership);
      }
    });
  });

  describe('owned by Gmail', () => {
    const mailWith = async (attachment: { filename: string; contentType: string; bytes: Buffer }) => {
      await control('/fake-gmail/messages', {
        method: 'POST',
        body: {
          id: `msg-${randomUUID()}`,
          subject: 'a pitch',
          from: 'founder@example.com',
          bodyText: 'see attached',
          attachments: [{ filename: attachment.filename, contentType: attachment.contentType, contentBase64: attachment.bytes.toString('base64') }],
        },
      });
    };

    it('File.read and extractOne read an attachment through the instance the run holds', async () => {
      await seedSlack([]);
      await mailWith({ filename: 'deck.pdf', contentType: 'application/pdf', bytes: textLayerPdf(PDF_LINE) });
      const reads = await run(overGmailAttachments('write dst-[:Messages]-> { Message: coalesce(File.read(a.File), "NOTHING READ") }'));
      expect(reads).toMatchObject({ status: 'success', failure_reason: null });
      expect(await posted()).toContain(PDF_LINE);

      await seedSlack([]);
      const extracts = await run(overGmailAttachments('write dst-[:Messages]-> { Message: coalesce(extractOne([a.File], Digest, { tier: "quick" }).items, "NOTHING EXTRACTED") }'));
      expect(extracts).toMatchObject({ status: 'success', failure_reason: null });
      expect((await posted()).join()).toContain(PDF_LINE);
    });

    it("another module's write takes the file: the bytes come through the owner the run holds", async () => {
      await seedSlack([]);
      const bytes = textLayerPdf(PDF_LINE);
      await mailWith({ filename: 'forward.pdf', contentType: 'application/pdf', bytes });
      // The fake names its upload URL on its default port, whichever it took.
      const realFetch = global.fetch;
      const rewritten = jest.spyOn(global, 'fetch').mockImplementation((url, init) => realFetch(String(url).replace('http://localhost:5556', mockFakeChannels.url), init));
      try {
        const settled = await run(overGmailAttachments('write dst-[:Messages]-> { Message: "forwarded", File: a.File }'));
        expect(settled).toMatchObject({ status: 'success', failure_reason: null });
      } finally {
        rewritten.mockRestore();
      }
      expect((await stored('file')).map((row) => row.content_base64)).toContain(bytes.toString('base64'));
    });
  });
});
