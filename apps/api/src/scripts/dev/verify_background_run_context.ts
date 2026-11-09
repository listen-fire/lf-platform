/**
 * A background run acts as its own team. Live proof that it does.
 *
 * Two bugs, one seam:
 *
 * 1. The background workers called into a firing with NO ambient Context, so
 *    the step that stores a fetched page (it scopes itself by the acting
 *    identity) threw `Async local storage undefined` inside the plugin, and a
 *    scheduled movement fetched nothing.
 * 2. The opposite: a Node timer carries the identity in scope where it was
 *    created, so a drain pass scheduled from a request ran as that request's
 *    team, and so did every pass after it. A webhook on the public routes woke
 *    the loop, a team's email run was then drained as the public team, and the
 *    deck it fetched was stored as a document of the public team. Attaching it
 *    to the team's own record then failed: "the file names the stored document
 *    …, which is not this team's".
 *
 * So this script runs a team's movement the way production does: queued, then
 * drained by the real drain loop, and the pass that runs it is woken from
 * inside a request of ANOTHER team, then of the public team. The movement
 * fetches a deck link that the local server serves as a PDF. The claims: the
 * deck's document row and its fetched-URL resource are the run's team's, the
 * attach's read of the deck (a module's `ctx.files`, the team check included)
 * succeeds, and nothing in the run says the file is outside the team.
 *
 *   npx ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/dev/verify_background_run_context.ts
 *
 * Stand-ins, and only these: the deck's host (a local server), the gated
 * document reader (a browser, in production; here it reads the local deck),
 * and the object store when this process has none configured (an in-process
 * one shaped like files-s3). No model is called, and no dev loop is needed:
 * the script seeds two fresh teams in whatever database it is pointed at.
 * Nothing outside this process is started or stopped.
 */
import './_profile_loader';

// Composition root — registers the services the fetch path reaches.
import '../../services';
import '../../services/translation_graph/engine/transforms/register-bundled';

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { AddressInfo } from 'node:net';
import type { DocumentProvider } from '../../adapters/document/interface';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { services } from '../../adapters/registry';
import { UnconfiguredDocumentProvider } from '../../adapters/document/unconfigured';
import { DocumentSourceService } from '../../lib/document_sources';
import { logger } from 'movement-engine/public/log';
import { documentStoreFileRef } from 'movement-engine/public/files';
import { getAutomationsQb, getCoreQb, getKnowledgeQb } from '../../lib/kysely';
import { Context, unsafeCurrentContext } from '../../services/context';
import { userPrincipal } from '../../services/principal';
import { PUBLIC_TEAM_ID } from '../../startup/core';
import { platformModuleFiles } from '../../services/translation_graph/engine/files/module_files';
import { saveMovement } from '../../services/translation_graph/movement/provision';
import { runMovementAsync } from '../../services/translation_graph/movement/run_now';
import { registerFireEventWork } from '../../services/inbound/fire_event';
import { notifyWork, startDrainLoop } from '../../services/work/drain';

// ── The deck the movement fetches ─────────────────────────────────────────

const DECK = Buffer.from('%PDF-1.4\n% a deck with no text layer\n%%EOF\n');

// ── Capturing the log the bugs used to hide in ────────────────────────────

const captured: string[] = [];

function captureLogs(): void {
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = logger[level].bind(logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logger as any)[level] = (message: unknown, meta?: unknown) => {
      captured.push(`${String(message)} ${meta === undefined ? '' : safeJson(meta)}`);
      return original(message as never, meta as never);
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Standing in for the gated reader and the object store ─────────────────

/** A DocSend link opens in a browser in production; the local deck is read
 *  here instead. Every other address goes to the real reader. */
function readLocalDecks(origin: string): void {
  const real = {
    isSupportedUrl: DocumentSourceService.isSupportedUrl.bind(DocumentSourceService),
    outputFormat: DocumentSourceService.outputFormat.bind(DocumentSourceService),
    getUrlAsPdfStream: DocumentSourceService.getUrlAsPdfStream.bind(DocumentSourceService),
  };
  const local = (url: string) => url.startsWith(origin);
  DocumentSourceService.isSupportedUrl = (url) => local(url) || real.isSupportedUrl(url);
  DocumentSourceService.outputFormat = (url) => (local(url) ? 'DOCUMENT' : real.outputFormat(url));
  DocumentSourceService.getUrlAsPdfStream = async (url, options) => {
    if (!local(url)) return real.getUrlAsPdfStream(url, options);
    const response = await fetch(url);
    return { name: 'DocSend.pdf', data: Readable.from([Buffer.from(await response.arrayBuffer())]) } as never;
  };
}

/** The configured object store when there is one; otherwise an in-process
 *  store shaped like files-s3 (a random folder per upload). */
function ensureObjectStore(): string {
  if (!(services.document instanceof UnconfiguredDocumentProvider)) return 'the configured object store';
  const objects = new Map<string, Buffer>();
  const BUCKET = 's3://listen-fire/';
  const stored = (objectUri: string) => {
    const bytes = objects.get(objectUri);
    if (bytes === undefined) throw new Error(`no object ${objectUri}`);
    return bytes;
  };
  const store = {
    upload: async (readable: Readable, { filename, keyPrefix }: { filename: string; keyPrefix?: string }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const objectUri = `${BUCKET}${keyPrefix !== undefined ? `${keyPrefix}/` : ''}${randomUUID()}/${filename}`;
      objects.set(objectUri, Buffer.concat(chunks));
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
    keyOf: (objectUri: string) => (objectUri.startsWith(BUCKET) ? objectUri.slice(BUCKET.length) : undefined),
  };
  // Implements every member of the published provider the platform reaches.
  services.document = store as unknown as DocumentProvider;
  return 'an in-process object store (none is configured here)';
}

// ── The movement ──────────────────────────────────────────────────────────

const MOVEMENT_NAME = 'background_run_context_probe';

// The manual invocation's text is the deck link itself, so no model is needed
// to find it.
const PROGRAM = `
import { fetchUrl } from plugins

function ${MOVEMENT_NAME}(go: <manual-[:Invocations]->>) {
  deck = fetchUrl(go.\`Text\`, { email: "x@y.z" })
}

listen to manual-[:Invocations]-> fire ${MOVEMENT_NAME}
`;

// ── The run's team, and another for the request that wakes the loop ───────

/** A fresh team with one write member: the probe needs no fake channels, so
 *  it seeds only what a manual run and a fetch touch. */
async function seedTeam(label: string): Promise<{ teamId: string; userId: string }> {
  const teamId = randomUUID() as TeamId;
  const userId = randomUUID() as UserId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `bg-probe-${label}-${teamId.slice(0, 8)}` } as any).execute();
  await getCoreQb(['user'])
    .insertInto('user')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: userId, default_team_id: teamId, username: `bg-probe-${userId.slice(0, 8)}`, granted_access_at: new Date() } as any)
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ user_id: userId, team_id: teamId, access: 'write' } as any)
    .execute();
  return { teamId, userId };
}

// ── One run, woken from somebody else's request ───────────────────────────

interface Probe {
  label: string;
  runStatus: string;
  failureReason: string | null;
  resourceTeam: string | null;
  documentTeam: string | null;
  attached: string;
}

async function runWokenBy(input: {
  label: string;
  teamId: string;
  movementId: string;
  deckUrl: string;
  kicker: { teamId: string; userId: string };
}): Promise<Probe> {
  // Queued while no loop runs in this process, so the only pass that can run
  // it is the one the other team's request wakes.
  const queued = await runMovementAsync({ teamId: input.teamId, movementId: input.movementId, text: input.deckUrl });
  if (!queued.ok) throw new Error(`the run was not queued: ${queued.errors.join('; ')}`);

  const stop = startDrainLoop({ owner: `verify-bg:${randomUUID().slice(0, 8)}`, everyMs: 60_000 });
  try {
    const request = new Context();
    request.bindPrincipal(userPrincipal(input.kicker));
    await request.runAsync(async () => notifyWork());

    const deadline = Date.now() + 120_000;
    let run: { status: string; failure_reason: string | null } | undefined;
    for (;;) {
      run = await getAutomationsQb(['trigger_run'])
        .selectFrom('trigger_run')
        .select(['status', 'failure_reason'])
        .where('id', '=', queued.runId as TriggerRunId)
        .executeTakeFirst();
      if (run !== undefined && run.status !== 'running') break;
      if (Date.now() > deadline) throw new Error(`run ${queued.runId} never finished`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const resource = await getKnowledgeQb(['resource'])
      .selectFrom('resource')
      .select(['team_id', 'document_id'])
      .where('url', '=', input.deckUrl)
      .executeTakeFirst();
    const document =
      resource?.document_id == null
        ? undefined
        : await getKnowledgeQb(['document'])
            .selectFrom('document')
            .select(['id', 'team_id', 'object_uri', 'description'])
            .where('id', '=', resource.document_id)
            .executeTakeFirst();

    // The attach's read: the file value the run's record carries for the
    // stored deck (as `hostedWebTools.fileValues` builds it), read as the
    // team's module reads a file handed to it.
    let attached = 'no document to attach';
    if (document !== undefined) {
      const file = documentStoreFileRef({ objectUri: document.object_uri, name: document.description });
      try {
        const bytes = await platformModuleFiles({ teamId: input.teamId as TeamId, module: '@lf/native-valuations' }).read(file);
        attached = `read ${bytes.byteLength} bytes`;
      } catch (error) {
        attached = `refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return {
      label: input.label,
      runStatus: run.status,
      failureReason: run.failure_reason,
      resourceTeam: resource?.team_id ?? null,
      documentTeam: document?.team_id ?? null,
      attached,
    };
  } finally {
    await stop();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  captureLogs();

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(DECK);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  readLocalDecks(origin);
  console.log(`serving the deck at ${origin}; storing in ${ensureObjectStore()}`);

  try {
    // ── Seeding. No Context is established here, and none is needed. ──────
    const seed = await seedTeam('run');
    const other = await seedTeam('other');
    const saved = await saveMovement({ audience: { for: 'run' }, teamId: seed.teamId, userId: seed.userId, source: PROGRAM });
    if (!saved.ok || saved.movementId === undefined) {
      console.error(JSON.stringify(saved, null, 2));
      throw new Error('the probe movement did not save');
    }
    if (unsafeCurrentContext() !== undefined) {
      throw new Error('a Context is in scope — this script must queue and drain without one');
    }
    registerFireEventWork();

    const probes: Probe[] = [];
    for (const [label, kicker] of [
      ['another team', other],
      ['the public team', { teamId: PUBLIC_TEAM_ID, userId: process.env.PUBLIC_USER_ID ?? randomUUID() }],
    ] as const) {
      probes.push(
        await runWokenBy({
          label,
          teamId: seed.teamId,
          movementId: saved.movementId,
          deckUrl: `${origin}/${randomUUID()}/deck`,
          kicker,
        }),
      );
    }

    // ── The claims ────────────────────────────────────────────────────────
    const failures: string[] = [];
    for (const probe of probes) {
      console.log(`\nwoken by ${probe.label}: ${JSON.stringify(probe)}`);
      const where = `woken by ${probe.label}`;
      if (probe.runStatus === 'failed') failures.push(`${where}: the run failed: ${probe.failureReason}`);
      if (probe.resourceTeam !== seed.teamId) {
        failures.push(`${where}: the fetched-URL resource is on team ${probe.resourceTeam}, not the run's ${seed.teamId}`);
      }
      if (probe.documentTeam !== seed.teamId) {
        failures.push(`${where}: the deck's document row is on team ${probe.documentTeam}, not the run's ${seed.teamId}`);
      }
      if (probe.attached !== `read ${DECK.byteLength} bytes`) {
        failures.push(`${where}: the attach could not read the deck: ${probe.attached}`);
      }
    }
    const outsideTeam = captured.filter((line) => line.includes('FILE_OUTSIDE_TEAM') || line.includes("which is not this team's"));
    if (outsideTeam.length > 0) failures.push(`the run reported a file outside its team: ${outsideTeam[0]?.slice(0, 300)}`);
    const noContext = captured.filter((line) => line.includes('Async local storage undefined'));
    if (noContext.length > 0) failures.push(`the run hit the missing Context ${noContext.length}×: ${noContext[0]?.slice(0, 300)}`);

    console.log('');
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      throw new Error(`${failures.length} claim(s) failed`);
    }
    console.log('OK — a run drained by a pass another team woke stored and attached its deck as its own team');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
