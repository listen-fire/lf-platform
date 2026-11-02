// A background run stores what it fetches under ITS team, whoever woke the
// drain loop that ran it.
//
// The bug this pins: a Node timer carries the identity in scope where it was
// created. A webhook on the public routes (which run as the public team) woke
// the loop, so the loop's next pass, and every pass after it, ran as the public
// team; the firing seam kept the Context it found; and the deck a team's email
// run fetched was stored as a `knowledge.document` row of the public team. The
// run then attached the deck to its own team's record, the read asked "is this
// document the team's?", and the answer was no (FILE_OUTSIDE_TEAM).
//
// Everything here is the real path but the third parties: the real drain loop
// against the real work table, the real firing seam, the platform's real fetch
// (resource row, document upload, document row), the real file values a plugin
// hands on, and the real byte read a module's `ctx.files` does, with the
// production ownership check against the database. Only the gated-document
// reader (a browser, in production) and the object store are stood in for.

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { AddressInfo } from 'node:net';
import type { DocumentProvider } from '../../../adapters/document/interface';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { FileRef } from 'movement-engine/public/adapter';

import { services } from '../../../adapters/registry';
import { DocumentSourceService } from '../../../lib/document_sources';
import { getAutomationsQb, getCoreQb, getKnowledgeQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { Context } from '../../context';
import { userPrincipal } from '../../principal';
import { platformModuleFiles } from '../../translation_graph/engine/files/module_files';
import { fetchWithTimeout } from '../../translation_graph/engine/transforms/fetch_resource';
import { hostedWebTools } from '../../translation_graph/engine/transforms/hosted_tools';
import { withFiringContext } from '../../translation_graph/movement/firing_context';
import { notifyWork, registerWorkKinds, resetWorkHandlersForTests, startDrainLoop, type StopDrainLoop } from '../drain';
import { enqueueWork, removeWork } from '../store';

// exposed_file_sweep is a real unit kind no other suite registers a handler
// for; registering it makes this process claim it (as drain.integration does).
const KIND = 'exposed_file_sweep';
// The public routes' team (`startup/core.ts`).
const PUBLIC_TEAM_ID = '3c556453-82b3-4314-ab78-67d843aaa7da';

const RUN = randomUUID().slice(0, 8);
const TEAM = randomUUID() as TeamId;
const OTHER_TEAM = randomUUID() as TeamId;
const AUTHOR = randomUUID() as UserId;
const OTHER_USER = randomUUID() as UserId;

let triggerId: TriggerId;
let origin: string;
let server: http.Server;
let previousDocumentStore: DocumentProvider | undefined;
const keys: string[] = [];

// ── The stand-ins: the deck's host, the object store, the gated reader ─────

const DECK = Buffer.from('%PDF-1.4\n% a deck nobody can read the text of\n%%EOF\n');

/** An object store shaped like files-s3: a random folder per upload, and a
 *  key read back only from its own bucket. */
function objectStore(): DocumentProvider {
  const objects = new Map<string, Buffer>();
  const BUCKET = 's3://listen-fire/';
  const keyOf = (objectUri: string) => (objectUri.startsWith(BUCKET) ? objectUri.slice(BUCKET.length) : undefined);
  const bytesOf = async (readable: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const stored = (objectUri: string) => {
    const bytes = objects.get(objectUri);
    if (bytes === undefined) throw new Error(`no object ${objectUri}`);
    return bytes;
  };
  const store = {
    upload: async (readable: Readable, { filename, keyPrefix }: { filename: string; keyPrefix?: string }) => {
      const objectUri = `${BUCKET}${keyPrefix !== undefined ? `${keyPrefix}/` : ''}${randomUUID()}/${filename}`;
      objects.set(objectUri, await bytesOf(readable));
      return { objectUri, checksum: randomUUID() };
    },
    getFileNodeStream: async ({ objectUri }: { objectUri: string }) => {
      const bytes = stored(objectUri);
      return Object.assign(Readable.from([bytes]), { size: bytes.byteLength, contentType: 'application/pdf' });
    },
    getFile: async ({ objectUri }: { objectUri: string }) => {
      const bytes = stored(objectUri);
      return { webStream: new Blob([bytes]).stream(), ContentLength: bytes.byteLength, ContentType: 'application/pdf' };
    },
    getDownloadUrl: async ({ objectUri }: { objectUri: string }) => objectUri,
    keyOf,
  };
  // The provider type is the published runtime's; this stand-in implements
  // every member the platform reaches and nothing else.
  return store as unknown as DocumentProvider;
}

/** The gated reader, for the local deck only: a DocSend link opens in a
 *  browser in production. */
function readDecksLocally(): void {
  jest.spyOn(DocumentSourceService, 'isSupportedUrl').mockImplementation((url: string) => url.startsWith(origin));
  jest.spyOn(DocumentSourceService, 'outputFormat').mockImplementation(() => 'DOCUMENT');
  jest.spyOn(DocumentSourceService, 'getUrlAsPdfStream').mockImplementation(async (url: string) => {
    const response = await fetch(url);
    return { name: 'DocSend.pdf', data: Readable.from([Buffer.from(await response.arrayBuffer())]) } as never;
  });
}

// ── The team, its listener, a stranger ────────────────────────────────────

async function member(input: { id: UserId; teamId: TeamId }): Promise<void> {
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: input.id, default_team_id: input.teamId, username: `bg-${input.id.slice(0, 8)}`, granted_access_at: new Date() } as any)
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ user_id: input.id, team_id: input.teamId, access: 'write' } as any)
    .execute();
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, `bg-run-${RUN}`], [OTHER_TEAM, `bg-other-${RUN}`]] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getCoreQb(['team']).insertInto('team').values({ id, name } as any).execute();
  }
  await member({ id: AUTHOR, teamId: TEAM });
  await member({ id: OTHER_USER, teamId: OTHER_TEAM });
  const trigger = await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ team_id: TEAM, name: 'deal inbox', kind: 'manual', config: JSON.stringify({}), created_by_user_id: AUTHOR } as any)
    .returning('id')
    .executeTakeFirstOrThrow();
  triggerId = trigger.id;

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(DECK);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    previousDocumentStore = services.document;
  } catch {
    previousDocumentStore = undefined;
  }
  services.document = objectStore();
});

beforeEach(() => {
  resetWorkHandlersForTests();
  readDecksLocally();
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const key of keys.splice(0)) await removeWork({ key });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousDocumentStore !== undefined) services.document = previousDocumentStore;
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', TEAM).execute();
  await cleanupTeam(TEAM);
  await cleanupTeam(OTHER_TEAM);
});

// ── The run ───────────────────────────────────────────────────────────────

function isFileRef(value: unknown): value is FileRef {
  return typeof value === 'object' && value !== null && '__brand' in value && value.__brand === 'FileRef';
}

interface RunOutcome {
  documentTeam: string | undefined;
  resourceTeam: string | null | undefined;
  attached: { ok: true; bytes: number } | { ok: false; error: string };
}

/** What a Dealflow Intake firing does with a deck link, as the loop runs it:
 *  fetch the link (the deck is stored), hand the stored document on as a file
 *  value, and attach it, which reads its bytes as the team's module does. */
async function intakeFiring(deckUrl: string): Promise<RunOutcome> {
  const event: TriggerEvent = {
    pipelineInputId: `trigger:${triggerId}`,
    adapterType: 'manual',
    triggerType: 'webhook',
    payload: { text: `Deck: ${deckUrl}` },
  };
  return withFiringContext({ teamId: TEAM, triggerId, event }, async () => {
    const fetched = await fetchWithTimeout(deckUrl, null);
    if (fetched?.documentId == null) throw new Error('the fetch stored no document');
    const document = await getKnowledgeQb(['document'])
      .selectFrom('document')
      .select('team_id')
      .where('id', '=', fetched.documentId as never)
      .executeTakeFirst();
    const resource = await getKnowledgeQb(['resource'])
      .selectFrom('resource')
      .select('team_id')
      .where('id', '=', fetched.resourceId)
      .executeTakeFirst();
    // What the plugin's record hands on: the stored document as a file value.
    const [file] = await hostedWebTools.fileValues([fetched.documentId]);
    if (!isFileRef(file)) throw new Error('the stored document gave no file value');
    let attached: RunOutcome['attached'];
    try {
      const bytes = await platformModuleFiles({ teamId: TEAM, module: '@lf/native-valuations' }).read(file);
      attached = { ok: true, bytes: bytes.byteLength };
    } catch (error) {
      attached = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      documentTeam: document?.team_id as string | undefined,
      resourceTeam: resource?.team_id as string | null | undefined,
      attached,
    };
  });
}

/** Run one intake firing on the real drain loop, woken from inside a request
 *  of `kickerTeam`. */
async function runKickedFrom(kickerTeam: string, kickerUser: string): Promise<RunOutcome> {
  let settle: (outcome: RunOutcome | Error) => void = () => {};
  const settled = new Promise<RunOutcome | Error>((resolve) => {
    settle = resolve;
  });
  registerWorkKinds([
    {
      kind: KIND,
      handler: {
        run: async (payload: unknown) => {
          const { deckUrl } = payload as { deckUrl: string };
          try {
            settle(await intakeFiring(deckUrl));
          } catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)));
          }
        },
      },
    },
  ]);
  // Due in 2001, so only this suite's rows are due to the loop's clock.
  const T0 = new Date('2001-01-01T00:00:00.000Z');
  const key = `${KIND}:bg-team:${randomUUID()}`;
  keys.push(key);
  await enqueueWork({ kind: KIND, key, payload: { deckUrl: `${origin}/${randomUUID()}/deck` }, dueAt: T0 });

  // Its own clock passes come only every minute: the pass that runs the row is
  // the one the request kicks.
  const stop: StopDrainLoop = startDrainLoop({ owner: 'bg-team', everyMs: 60_000, now: () => new Date(T0.getTime() + 1_000) });
  try {
    const request = new Context();
    request.bindPrincipal(userPrincipal({ userId: kickerUser, teamId: kickerTeam }));
    await request.runAsync(async () => notifyWork());
    const outcome = await Promise.race([
      settled,
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('the loop never ran the row')), 30_000)),
    ]);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  } finally {
    await stop();
  }
}

describe('a background run woken by another team’s request', () => {
  it.each([
    ['another team', () => OTHER_TEAM as string, () => OTHER_USER as string],
    // No user row is needed: the identity only has to be in scope.
    ['the public team', () => PUBLIC_TEAM_ID, () => randomUUID()],
  ])('woken from %s, stores the deck under its own team and attaches it', async (_label, kickerTeam, kickerUser) => {
    const outcome = await runKickedFrom(kickerTeam(), kickerUser());

    expect(outcome).toEqual({
      documentTeam: TEAM,
      resourceTeam: TEAM,
      attached: { ok: true, bytes: DECK.byteLength },
    });
  });
});
