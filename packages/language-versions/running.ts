// What crosses into a carried version's run host, in the current release's
// terms: the request and the outcome as plain data, and the platform's
// services as functions over plain data. A carried version states the same
// shapes in its own release's terms, and the compiler holds the two to each
// other where its entry loads it (`index.ts`). The platform builds one
// `RunPlatform` for every carried version: its model calls, file text, record
// bindings, write locks, write ledger, module hosting and run host (its parks,
// waits and wakes, and the drains that step a parked run) are shared, and each
// version brings its own engine, host kit and modules.
//
// No error class crosses. A carried version's failure comes back as text and
// its code; a lost lease as its own outcome; the platform's cancel and lease
// go in as answers to questions, never as the platform's classes.

import type { DryRunWriteSink, FileRef, ResolveFileRefResult } from 'movement-engine/public/adapter';
import type { CredentialOwnership, EngineHost } from 'movement-engine/public/host';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { MovementRunResult } from 'movement-engine/public/movement-engine';
import type { MovementTraceEntry } from 'movement-engine/public/trace';
import type { WriteLocks } from 'movement-engine/public/write-locks';
import type { ModuleCredential, ModuleFiles, ModuleIdentities, ModuleKv, ModuleLog, ModuleModels } from 'module-kit';
import type { KgStore } from '@listen-fire/kg/store';
import type { SlackComposeChat } from '@listen-fire/slack/compose';
import type { SystemRecords } from '@listen-fire/system/records';

import type { CheckRequest, TeamFacts } from './index';

/** The team member a carried run acts as. 0.16 retired the shape from the
 *  engine (who acted is a claim), so it is stated here, as a version from
 *  before 0.16 hands it back. */
export interface ActingUser {
  id: string;
  email: string;
  name?: string | null;
}

/** One install of a module a run constructs. */
export interface ModuleInstall {
  teamId: string;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}

/** Who a module is and the credentials it declares, as the platform needs to
 *  host it: the stored credential is read as the first of them (or the one
 *  the module's line names) and refreshed under the platform's one lock. */
export interface ModuleDeclaration {
  name: string;
  displayName: string;
  credentials: readonly {
    name: string;
    kind: string;
    oauth2?: { tokenUrl: string; scopes?: readonly string[] };
    fields?: readonly { name: string }[];
  }[];
}

/** What the platform hosts one install of a module with, whichever release's
 *  module it is. */
export interface ModuleHostPieces {
  credential: ModuleCredential;
  kv: ModuleKv;
  files: ModuleFiles;
  identities?: ModuleIdentities;
  fetch?: typeof fetch;
  baseUrlOverride?: string;
  models?: ModuleModels;
}

/** The platform's parts its own modules are defined with. */
export interface PlatformModuleParts {
  askAnswerUrl(token: string): string;
  kgStore(install: { teamId: string; credentialsId: string | undefined }): KgStore;
  kgChangeWebhooks: boolean;
  slackChat: SlackComposeChat;
  readFile(ref: FileRef, teamId: string): Promise<{ body: Buffer; contentType?: string }>;
  whatsappNumber: string | null;
  isExposedFileUrl(url: string): boolean;
  readDocument(ref: FileRef, options: { teamId: string }): Promise<ResolveFileRefResult>;
  /** What a carried version's system module reads of a team's own events. */
  systemRecords(tenant: string): CarriedSystemRecords;
  /** A team's install of a remote adapter: its stored manifest file (JSON,
   *  read by the version in its own terms), its server secret, the document
   *  store a fetched file lands in, and the connection's provider credential
   *  when it names one. */
  remoteInstall(input: { adapterType: string; teamId: string; credentialsId?: string }): Promise<{
    manifest: unknown;
    secret: string;
    credentialsId: string;
    documents: RemoteDocuments;
    credential?: RemoteCredential;
  }>;
}

export interface ModulePlatform {
  hostFor(input: { adapterType: string; install: ModuleInstall; declaration: ModuleDeclaration }): ModuleHostPieces;
  parts: PlatformModuleParts;
  log: ModuleLog;
  validateResults: boolean;
}

/** The instance a carried segment holds for a file's owner, as a byte reader
 *  needs it: the one method that serves the file's bytes. */
export interface CarriedFileOwner {
  resolveFileRef?(input: { ref: FileRef }): Promise<ResolveFileRefResult>;
}

/** The platform's services a carried version's segment reaches. */
export interface RunPlatform {
  modules: ModulePlatform;
  /** Where this version's engine reports which engine ran a segment: the run's row. */
  recordEngine(record: { runId: string; engine: 'ts' | 'rust' }): void;
  credentials: CredentialOwnership;
  /** Billed and metered by the platform. */
  llm: EngineHost['llm'];
  files: EngineHost['files'];
  /** Runs `call` with `owners` as where the platform's byte readers find a
   *  file's owner. A carried version's own scope is not the one they read, so
   *  it sets this around each file read and module call of a segment. */
  withFileOwners<T>(
    owners: (owner: { adapterType: string; credentialsId?: string; constructionArgs?: Record<string, string> }) => CarriedFileOwner | undefined,
    call: () => Promise<T>,
  ): Promise<T>;
  bindings: EngineHost['park']['bindings'];
  /** The cross-run write locks every version shares. */
  locks: WriteLocks;
  /** The run's event stays with its version: it asks its own module, in
   *  `candidates`, who the event says acted. */
  actingUser(input: {
    teamId: string;
    triggerId?: string;
    candidates(): Promise<unknown>;
  }): Promise<ActingUser | null>;
  control: {
    cancelled(): Promise<boolean>;
    cancelledNow(): Promise<boolean>;
    leaseLost(): boolean;
  };
  /** The write ledger every version's writes go into; absent for a
   *  rehearsal. */
  keepWrite?(write: { adapterType: string; recordType: string; externalId: string; at: string }): Promise<void>;
  writeSink?: DryRunWriteSink;
  /** Where the segment's parks go: the platform's own run host, which every
   *  version parks in and resumes from; absent for a rehearsal, which never
   *  parks. */
  park?: SharedParks;
}

/** The platform's park family, which a carried version's segment parks
 *  through exactly as a current one does: the run host's sink, waits and wake
 *  over its rows, and the library texts its parks pin. A park's state is the
 *  engine's own and crosses unread; 0.15's and this release's are one shape
 *  (`engine-contracts`' park state), which is what lets one run host step
 *  both. */
export type SharedParks = Omit<EngineHost['park'], 'bindings'>;

/** One segment of a run the version parked. */
export interface ResumeRequest extends Omit<SegmentRequest, 'dryRun'> {
  runId: string;
  /** The parked leaf's state as the row holds it: the version reads it. */
  state: unknown;
  /** The answer an ask resumes with, bound as its result. */
  answer?: unknown;
  reenter?: boolean;
  deferRaceSettlement?: boolean;
  settleRaceFrameAddress?: string;
  priorSpentMicrodollars?: number;
  capBaselineMicrodollars?: number;
  limitPaused?: boolean;
  parkedOnEngine?: 'ts' | 'rust';
}

/** A carried version's segments of a run it parked. Which leaves a drain
 *  steps, and in what order, are the platform's run host's: every version's
 *  parks are its rows. */
export interface ResumingLane {
  resumeSegment(request: ResumeRequest, platform: RunPlatform): Promise<SegmentOutcome>;
  readEvent(event: CarriedEvent): CarriedEventReading;
  manualListens(request: { source: string; pin: string }): string[];
}

/** An event in a carried version's own shape, as JSON: the version made it
 *  (`manualInvocationEvent`) or reads it, and checks it against its own
 *  schema where it arrives. The platform reads it only as data. */
export type CarriedEvent = Readonly<Record<string, unknown>>;

/** What the platform records of a carried event: its version read it with
 *  its own schema, and answers these fields as plain data. */
export interface CarriedEventRecord {
  pipelineInputId: string;
  adapterType: string;
  triggerType: TriggerEvent['triggerType'];
  payload?: unknown;
  recordId?: string;
  occurredAt?: string;
  idempotencyKey?: string;
  /** Who made the change, when its source says. */
  actor?: { type: 'user' | 'system' | 'api-token'; id: string | null };
}

/** A carried event read by its own version, or why that version cannot read
 *  it. */
export type CarriedEventReading = { ok: true; record: CarriedEventRecord } | { ok: false; reason: string };

/** One segment someone started, from its first statement. */
export interface SegmentRequest {
  source: string;
  pin: string;
  movementName?: string;
  event: CarriedEvent;
  teamId: string;
  firedAt: string;
  runId?: string;
  costCapMicrodollars?: number;
  dryRun?: boolean;
  team: TeamFacts;
  trace?: MovementTraceEntry[];
  /** Where the delivery that started the run was kept in the arrival log:
   *  the waits it opens on its trigger read from there. */
  triggerMark?: number;
}

export type SegmentOutcome =
  | { kind: 'ran'; result: MovementRunResult }
  | { kind: 'failed'; code?: string; message: string; partial?: MovementRunResult }
  | { kind: 'lease-lost'; message: string };

/** A Run now press, as a manual invocation carries it. */
export interface ManualInvocation {
  firedAt: string;
  submissionId?: string;
  actorEmail?: string;
  actorName?: string;
  text?: string;
  files?: { objectUri: string; filename: string; contentType: string; size?: number }[];
}

/** A carried version's run host for segments someone starts. */
export interface RunningLane {
  runSegment: (request: SegmentRequest, platform: RunPlatform) => Promise<SegmentOutcome>;
  /** The movements the program's manual listens fire, in file order. */
  manualListens: (request: { source: string; pin: string }) => string[];
  /** A Run now press as the event the version's manual unit reads. */
  manualInvocationEvent: (input: { key: string; invocation: ManualInvocation; requestId?: string }) => CarriedEvent;
  /** An event in the version's own shape, read with its own schema: what the
   *  platform records of it, or why it cannot be read. */
  readEvent: (event: CarriedEvent) => CarriedEventReading;
  /** Every adapter type a run reaches through a module the platform hosts:
   *  each needs a module line on the platform. */
  hostedModuleTypes: () => string[];
}

// ── A carried version's half of a delivery ─────────────────────────────────

/** A trigger row as the platform keeps it, with the pin its automation
 *  shipped under. */
export interface ListenRow {
  id: string;
  kind: string;
  credentialsId: string | null;
  config: unknown;
  firedMovementName: string | null;
  pin: string;
}

/** What the door kept of a request (no signature: the door verified it). */
export interface CarriedKeptDelivery {
  body: string;
  /** The request's `content-type`, which says how the body is read. */
  contentType?: string;
  /** The cursor the door read it against: every version reads from there. */
  checkpoint?: unknown;
}

export interface ReadDeliveryRequest {
  teamId: string;
  adapterType: string;
  credentialsId: string | null;
  matchAnyCredential?: boolean;
  delivery: CarriedKeptDelivery;
  listens: readonly ListenRow[];
  now: string;
}

export interface ReadDeliveryOutcome {
  /** One per listen an arrival fired: the event its run is handed, in the
   *  version's own shape, and what names the arrival it fired on, so a page
   *  judged again keeps one receipt. */
  receipts: { triggerId: string; event: Record<string, unknown>; arrivalKey: string }[];
  /** Why an arrival ran nothing, for the log. */
  lines: string[];
  /** The edges of the arrivals it read, fired or not: an arrival on a listed
   *  hop's edge whose members' changes are pushed lists its listen again. */
  edges: string[];
}

/** A page of arrivals a door built itself (an email, a WhatsApp message, an
 *  ask's answer, a remote module's push, a page a poll answered), as plain
 *  data the version reads with its own arrival schema. A page for no
 *  connection is the module's install's, which serves every connection. */
export interface JudgePageRequest extends Omit<ReadDeliveryRequest, 'delivery'> {
  page: readonly unknown[];
}

/** How a module delivers a listen's last edge, as the version read its
 *  declaration. */
export interface WatchedDelivery {
  kind: 'connection' | 'scope' | 'polled';
  pollEverySeconds?: number;
  /** An edge pushed per scope is subscribed per record this earlier edge
   *  lands on (Airtable's `Changes`, per base). */
  scopedBy?: string;
}

/** One traversal a carried listen is watched by: its own, or one member's of
 *  a union (`member`, its place among them). */
export interface WatchedTraversal {
  member?: number;
  edge: string;
  /** The part of the last hop's filter the module takes. */
  taken?: unknown;
  delivery?: WatchedDelivery;
  /** Some earlier hop's members the host lists. */
  resolves: boolean;
  relistEverySeconds?: number;
  /** The edges of its listed hops whose members' changes are pushed. */
  pushedParentEdges: string[];
}

/** How a carried listen is watched, as its version reads its own plan: what
 *  the platform's polls, subscriptions and listings share it by. */
export interface ListenWatch {
  pipeline: string;
  adapter: string;
  movement: string;
  constructionArgs?: Record<string, string>;
  traversals: WatchedTraversal[];
}

/** The install of a module an edge is watched through, and the edge. */
export interface WatchedEdgeRequest {
  teamId: string;
  adapterType: string;
  credentialsId: string | null;
  constructionArgs?: Record<string, string>;
  edge: string;
  filter?: unknown;
  scope?: string;
}

/** A poll's page, as plain data the version's `judgePage` reads back. */
export interface PolledPage {
  page: unknown[];
  cursor?: unknown;
  /** When the module said the edge is next worth polling, an ISO instant. */
  pollAgainAt?: string;
}

export type SubscribeOutcome = { kind: 'unanswered' } | { kind: 'registered'; externalId?: string; secret?: string };

/** What listing a carried listen's members came to. */
export type ScopeListing = { kind: 'listed'; heads: string[]; members?: { heads: string[] }[] } | { kind: 'over-limit'; recordType: string };

export type GateAnswer = { kind: 'suppress'; reason: string } | { kind: 'proceed' } | { kind: 'needs-actor'; candidates: unknown };

/** The platform's own events for one team, as a carried version's system
 *  module reads them: 0.15's records are this release's (`@listen-fire/system`). */
export type CarriedSystemRecords = SystemRecords;

/** One listen as its version's check plans it: the config its trigger row
 *  keeps, in the version's own listen shape, which only that version reads
 *  again. The platform reads only what names the row: its pipeline, the
 *  module and the movement it fires, and the connection it names. */
export type CarriedListenConfig = Readonly<Record<string, unknown>> & {
  pipeline: string;
  /** `alias`: a `listen as "…"`'s name, which names its trigger row. */
  plan: { readonly adapter: string; readonly movement: string; readonly alias?: string };
  credentialName?: string;
  constructionArgs?: Record<string, string>;
};

/** One listen as its version plans it: the config its row keeps, and the
 *  dry_run⇄live axis its fired function's writes imply, read off the
 *  version's own parse. */
export interface PlannedListen {
  listen: CarriedListenConfig;
  textRunMode: 'live' | 'dry_run';
}

/** A file's listens as its version plans them; a listen the platform would
 *  not fire as written is refused by name. A text the version cannot read has
 *  its refusal instead. */
export type PlannedListens = { ok: true; listens: PlannedListen[]; refused: string[] } | { ok: false; refused: string };

/** A carried version's listens, in the plan shape every version's trigger rows
 *  share: the row's pin chooses the version, and only that version plans,
 *  reads, judges and gates them. A row's plan is read with its own release's
 *  schema, never another's. */
export interface ListeningLane {
  /** The listens a file states, planned by the version's own check. */
  planListens(request: CheckRequest & { file: string }): Promise<PlannedListens>;
  /** Whether a kept row's config reads as a listen under the version's own
   *  plan schema. */
  isListenRow(row: Pick<ListenRow, 'config'>): boolean;
  /** A kept delivery read again by the version's own module, each arrival
   *  judged by its own judge against the rows pinned to it. */
  readDelivery(request: ReadDeliveryRequest, modules: ModulePlatform): Promise<ReadDeliveryOutcome>;
  /** What the source module says of a firing before it runs: the version's
   *  own gate. */
  gateFiring(request: { teamId: string; adapterType: string; credentialsId: string | null; config: unknown; event: CarriedEvent }, modules: ModulePlatform): Promise<GateAnswer>;
  readEvent(event: CarriedEvent): CarriedEventReading;
  /** A page a door built, each arrival read with the version's own arrival
   *  schema and judged by its own judge against the rows pinned to it. */
  judgePage(request: JudgePageRequest): ReadDeliveryOutcome;
  /** How a kept row is watched, read with the version's own plan schema; null
   *  for a row that is not its listen. */
  watchOf(row: Pick<ListenRow, 'config'>): ListenWatch | null;
  /** One poll of an edge by the version's own module. */
  pollEdge(request: WatchedEdgeRequest & { cursor?: unknown }, modules: ModulePlatform): Promise<PolledPage>;
  /** An edge's subscription registered by the version's own module. */
  subscribeEdge(request: WatchedEdgeRequest & { callbackUrl: string; current?: { externalId: string } }, modules: ModulePlatform): Promise<SubscribeOutcome>;
  /** An edge's subscription withdrawn by the version's own module. */
  unsubscribeEdge(request: WatchedEdgeRequest & { callbackUrl: string; externalId?: string }, modules: ModulePlatform): Promise<void>;
  /** A listen's members listed by the version's own module and judge. */
  listScope(request: { teamId: string; credentialsId: string | null; config: unknown; limit: number }, modules: ModulePlatform): Promise<ScopeListing>;
}

/** What a remote adapter of this release stores fetched files in, and the
 *  provider credential it sends. */
type RemoteInput = Parameters<typeof import('movement-engine/public/modules').createRemoteAdapter>[0];
export type RemoteDocuments = RemoteInput['documents'];
export type RemoteCredential = NonNullable<RemoteInput['credential']>;
