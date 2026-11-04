// What crosses into a carried version's run host, in the current release's
// terms: the request and the outcome as plain data, and the platform's
// services as functions over plain data. A carried version states the same
// shapes in its own release's terms, and the compiler holds the two to each
// other where its entry loads it (`index.ts`). The platform builds one
// `RunPlatform` for every carried version: its model calls, file text, record
// bindings, write locks, write ledger and module hosting are shared, and each
// version brings its own engine, host kit and modules.
//
// No error class crosses. A carried version's failure comes back as text and
// its code; a lost lease as its own outcome; the platform's cancel and lease
// go in as answers to questions, never as the platform's classes.

import type { ActingUser, DryRunWriteSink, FileRef, ResolveFileRefResult } from 'movement-engine/public/adapter';
import type { CredentialOwnership, EngineHost } from 'movement-engine/public/host';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { MovementRunResult } from 'movement-engine/public/movement-engine';
import type { MovementTraceEntry } from 'movement-engine/public/trace';
import type { WriteLocks } from 'movement-engine/public/write-locks';
import type { ModuleCredential, ModuleFiles, ModuleIdentities, ModuleKv, ModuleLog, ModuleModels } from 'module-kit';
import type { KgStore } from '@listen-fire/kg/store';
import type { SlackComposeChat } from '@listen-fire/slack/compose';

import type { TeamFacts } from './index';

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
  /** What a carried version's system module reads of the platform's own events. */
  systemRecords: CarriedSystemRecords;
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

/** The platform's services a carried version's segment reaches. */
export interface RunPlatform {
  modules: ModulePlatform;
  /** Where this version's engine reports which engine ran a segment: the run's row. */
  recordEngine(record: { runId: string; engine: 'ts' | 'rust' }): void;
  credentials: CredentialOwnership;
  /** Billed and metered by the platform. */
  llm: EngineHost['llm'];
  files: EngineHost['files'];
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
  /** Where the segment's parks and callbacks go; absent for a rehearsal. */
  parks?: CarriedParks;
}

// ── The rows a carried version's run parks in, and its rules over them ─────
//
// The platform keeps the rows; the version brings the rules (which leaves a
// drain steps, how a callback's call lands, what a withdrawn await closes), so
// a run parked under a version is stepped by that version. A park's state is
// the version's, and stays unread here.

/** How a fenced write came out: the version throws its own lost-lease class. */
export type FencedWrite = 'written' | 'lease-lost';

export interface CarriedLeaf {
  address: string;
  reason: string;
  status: 'parked' | 'resuming';
  wakeAt: string | null;
}

export interface CorrelatedPark {
  runId: string;
  teamId: string;
  address: string;
}

export interface CarriedClaimedWork {
  id: string;
  kind: string;
  key: string;
  payload?: unknown;
  claim: string;
}

export interface CarriedRunStore {
  parks: {
    putLeaf(input: { runId: string; address: string; reason: string; wakeAt: string | null; state?: unknown; rewritten?: boolean; fence?: string }): Promise<FencedWrite>;
    claimLeaf(input: { runId: string; address: string; reason?: string }): Promise<{ state?: unknown; reason: string } | null>;
    finishLeaf(input: { runId: string; address: string; fence?: string }): Promise<void>;
    leaves(input: { runId: string; parkedOnly?: boolean; reason?: string; dueBy?: string }): Promise<CarriedLeaf[]>;
    deleteLeaves(input: { runId: string; addresses: readonly string[] }): Promise<void>;
  };
  joins: {
    recordJoin(input: { runId: string; frameAddress: string; pending: number; fence?: string }): Promise<FencedWrite>;
    decrementJoin(input: { runId: string; frameAddress: string; branchAddress: string; leafAddress: string }): Promise<{ closed: boolean }>;
    persistBranchExport(input: { runId: string; frameAddress: string; branchAddress: string; branchIndex: number; exports: unknown }): Promise<void>;
    collectBranchExports(input: { runId: string; frameAddress: string }): Promise<Array<{ branchAddress: string; branchIndex: number; exports?: unknown }>>;
    hasPendingJoins(input: { runId: string }): Promise<boolean>;
    frames(input: { runId: string }): Promise<string[]>;
    deleteFrames(input: { runId: string; frameAddresses: readonly string[] }): Promise<void>;
  };
  correlations: {
    correlate(input: { runId: string; teamId: string; address: string; adapterType: string; correlationKey: string }): Promise<void>;
    correlated(input: { adapterType: string; teamId: string; correlationKey: string }): Promise<CorrelatedPark[]>;
    ofRun(input: { runId: string; adapterType: string }): Promise<Array<CorrelatedPark & { correlationKey: string }>>;
    drop(input: { runId: string; address: string }): Promise<void>;
    dropRun(input: { runId: string }): Promise<void>;
  };
  leases: {
    claim(input: { runId: string; ttlMs: number }): Promise<{ token: string } | null>;
    renew(input: { runId: string; token: string; ttlMs: number }): Promise<boolean>;
    release(input: { runId: string; token: string }): Promise<void>;
    dropRunState(input: { runId: string; fence?: string }): Promise<boolean>;
  };
  work: {
    enqueue(input: { kind: string; key: string; payload: unknown; dueAt?: string; teamId?: string }): Promise<void>;
    enqueueIfAbsent(input: { kind: string; key: string; payload: unknown; dueAt?: string; teamId?: string }): Promise<boolean>;
    claimDue(input: { limit: number; leaseMs: number; dueBy?: string; kinds?: readonly string[] }): Promise<CarriedClaimedWork[]>;
    complete(work: CarriedClaimedWork): Promise<void>;
    release(work: CarriedClaimedWork & { dueAt?: string }): Promise<void>;
  };
  sources: {
    put(input: { teamId: string; hash: string; source: string }): Promise<void>;
    get(input: { teamId: string; hash: string }): Promise<string | null>;
  };
}

export type CarriedCallbackStatus = 'live' | 'fired' | 'revoked';

export interface CarriedCallbackRecord {
  id: string;
  teamId: string;
  runId: string;
  address: string;
  params: { name: string; type: string }[];
  state?: unknown;
  calls: { at: string; values: Record<string, unknown>; bodyStartedAt?: string }[];
  singleUse: boolean;
  expiresAt: string | null;
  status: CarriedCallbackStatus;
}

export type CarriedCallbackClaim =
  | { kind: 'recorded'; callback: CarriedCallbackRecord; callIndex: number }
  | { kind: 'not_found' }
  | { kind: 'closed' | 'expired'; callback: CarriedCallbackRecord };

export interface CarriedCallbackStore {
  mint(input: { teamId: string; runId: string; address: string; params: { name: string; type: string }[]; state: unknown; singleUse: boolean; expiresAt?: string }): Promise<{ id: string }>;
  get(input: { id: string }): Promise<CarriedCallbackRecord | null>;
  record(input: { id: string; values: Record<string, unknown>; bodyDueAt: string }): Promise<CarriedCallbackClaim>;
  markBodyStarted(input: { id: string; callIndex: number; fence?: string }): Promise<boolean>;
  landed(input: { ids: readonly string[] }): Promise<string[]>;
  revokeRun(input: { runId: string }): Promise<void>;
}

/** The platform's run rows and records, as a carried version's rules reach
 *  them. */
export interface CarriedRunHost {
  store: CarriedRunStore;
  callbacks: CarriedCallbackStore;
  /** An ask await resolves when its ask settles; a withdrawn one closes it. */
  askAwaits: {
    loadResolvable(input: { runId: string }): Promise<CorrelatedPark[]>;
    abandon(input: { runId: string; addresses?: readonly string[] }): Promise<void>;
  };
  runs: {
    cancelRequest(input: { runId: string }): Promise<{ reason: string | null } | null>;
    markFailed(input: { runId: string; message: string }): Promise<void>;
    closeRun?(input: { runId: string }): Promise<void>;
  };
  log: {
    warn(message: string, fields: Record<string, unknown>): void;
    error(message: string, fields: Record<string, unknown>): void;
  };
}

/** What one segment's parks are written through. */
export interface CarriedParks {
  host: CarriedRunHost;
  /** The run lease the segment steps under: its parks land only under it. */
  fence?: string;
  ensureRun(): Promise<void>;
  markParked(): Promise<void>;
  markLimitPaused(pause: { limit: 'cost'; capMicrodollars: number; spentMicrodollars: number }): Promise<void>;
  callbackUrl(id: string): string;
  notifyWork(): void;
}

/** A lease held on a run while a carried version steps it. */
export interface CarriedLease {
  readonly runId: string;
  readonly token: string;
  isLost(): boolean;
  release(): Promise<void>;
}

export interface CarriedLeaseOptions {
  ttlMs?: number;
  beforeRelease?: (runId: string) => Promise<void>;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

/** One segment a carried version's drain asks the platform to run. */
export type CarriedStepRequest =
  | { kind: 'leaf'; address: string; reason: string; state: unknown; reenter: boolean; deferRaceSettlement: true }
  | { kind: 'race'; frameAddress: string; state: unknown };

export type CarriedStepOutcome =
  | { kind: 'leaseLost' }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason?: string }
  | { kind: 'parked'; parkedAddress: string | undefined; deferredRaceFrames: readonly string[] }
  | { kind: 'completed'; deferredRaceFrames: readonly string[] };

export type CarriedStep = (request: CarriedStepRequest, settle: { runComplete(): Promise<boolean> }) => Promise<CarriedStepOutcome>;

export type CarriedStepperFor = (input: { runId: string; lease: CarriedLease }) => Promise<CarriedStep | null>;

export type CarriedBodyOutcome =
  | { kind: 'ran' }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason?: string }
  | { kind: 'leaseLost' };

export type CarriedBodyRun = { kind: 'ran'; outcome: CarriedBodyOutcome } | { kind: 'not_started' } | { kind: 'refused'; reason: string };

/** One segment of a run the version parked. */
export interface ResumeRequest extends Omit<SegmentRequest, 'dryRun'> {
  runId: string;
  /** The parked leaf's state as the row holds it: the version reads it. */
  state: unknown;
  reenter?: boolean;
  deferRaceSettlement?: boolean;
  settleRaceFrameAddress?: string;
  /** Run this callback's body rather than resuming a leaf. */
  callback?: { values: Record<string, unknown>; callIndex: number };
  priorSpentMicrodollars?: number;
  capBaselineMicrodollars?: number;
  limitPaused?: boolean;
  parkedOnEngine?: 'ts' | 'rust';
}

/** A carried version's rules over a parked run, and its segments of one. */
export interface ResumingLane {
  resumeSegment(request: ResumeRequest, platform: RunPlatform): Promise<SegmentOutcome>;
  readEvent(event: CarriedEvent): CarriedEventReading;
  manualListens(request: { source: string; pin: string }): string[];
  drainDueTimers(host: CarriedRunHost, input: { runId: string; dueBy: string; lease?: CarriedLease; step: CarriedStep }): Promise<'done' | 'leaseLost'>;
  drainLeaves(
    host: CarriedRunHost,
    input: { runId: string; addresses: readonly string[]; reason: string; lease?: CarriedLease; step: CarriedStep; until?: () => Promise<boolean> },
  ): Promise<'done' | 'leaseLost'>;
  wakeAwaits(
    host: CarriedRunHost,
    input: {
      wake: { adapterType: string; teamId: string; correlationKey: string };
      stepper: CarriedStepperFor;
      around?: (runId: string, body: () => Promise<void>) => Promise<void>;
      lease?: CarriedLeaseOptions;
    },
  ): Promise<{ busy: string[] }>;
  queueAwaitWake(host: CarriedRunHost, wake: { adapterType: string; teamId: string; correlationKey: string }, opts?: { coalesceKey?: string; dueAt?: string }): Promise<void>;
  runCallbackBody(
    host: CarriedRunHost,
    input: {
      id: string;
      callIndex: number;
      lease: CarriedLease;
      now: string;
      runOpen: (runId: string) => Promise<boolean>;
      body: (input: { callback: CarriedCallbackRecord; values: Record<string, unknown> }) => Promise<CarriedBodyOutcome>;
      stepper: CarriedStepperFor;
    },
  ): Promise<CarriedBodyRun>;
  coerceCallbackValues(
    params: CarriedCallbackRecord['params'],
    raw: Record<string, unknown>,
  ): { ok: true; values: Record<string, unknown> } | { ok: false; message: string };
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

/** A trigger row as the platform keeps it, with the text its automation
 *  shipped, which only the version reads. */
export interface ListenRow {
  id: string;
  kind: string;
  credentialsId: string | null;
  config: unknown;
  firedMovementName: string | null;
  source: string;
  pin: string;
}

/** What the door kept of a request (no signature: the door verified it). */
export interface CarriedKeptDelivery {
  body: string;
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
  receipts: { triggerId: string; event: Record<string, unknown> }[];
  wakeKeys: string[];
  lines: string[];
}

export type GateAnswer = { kind: 'suppress'; reason: string } | { kind: 'proceed' } | { kind: 'needs-actor'; candidates: unknown };

/** The platform's own events, as a carried version's system module reads them. */
export interface CarriedSystemRecords {
  failedRuns(input: { tenant: string; after: { failedAt: string; runId: string }; until: Date; limit: number }): Promise<
    Array<{ runId: string; automation: { id: string; name: string } | null; firedMovement?: string; url?: string; reason: string; failedAt: Date }>
  >;
  storedEvents(input: { tenant: string; kinds: readonly string[]; after: { occurredAt: string; id: string }; until: Date; limit: number }): Promise<
    Array<{ id: string; kind: string; payload: CarriedSystemEventPayload; occurredAt: Date }>
  >;
  webBaseUrl(): string;
}

/** A stored platform event's payload, as its version's module reads it. */
export interface CarriedSystemEventPayload {
  automation: string;
  automationId: string;
  runId: string;
  version: string;
  reason: string;
  url: string;
  at: string;
}

export interface AddressRequest {
  teamId: string;
  adapter: string;
  credentialsId: string | null;
  constructionArgs?: Record<string, string>;
  config: Record<string, unknown>;
}

export type AddressResolution = { ok: true; address: Record<string, string> } | { ok: false; reason: string };

export interface ChannelRow {
  name: string;
  kind: string;
  credentialsId: string | null;
  config: unknown;
  resolvedAddress: unknown;
}

export interface RemoteChannelFacts {
  adapterType: string;
  methods: readonly string[];
  requiredCredentialType?: string;
}

/** One webhook a carried version's listens want. */
export interface Channel {
  slug: string;
  providerKey: string;
  credentialsId: string | null;
  events: string[];
  scope: Record<string, string>;
}

export interface ChannelRegistration {
  externalId?: string;
  secret?: string;
}

/** Where a carried listen stood, as its row keeps it, for the current version's
 *  edge the cursor is asked for. */
export interface HeardSoFar {
  adapterType: string;
  edge: string;
  pollCheckpoint: unknown;
  cronLastFiredAt: string | null;
}

/** A carried version's own reading and judging of a kept delivery. */
export interface ListeningLane {
  /** What a text's listen on `movementName` rehearses, off its own parse. */
  writeRunModeOf(request: { source: string; pin: string; movementName: string }): 'live' | 'dry_run';
  resolveListenAddress(request: AddressRequest, modules: ModulePlatform): Promise<AddressResolution>;
  channelsOf(
    request: { rows: readonly ChannelRow[]; slugOf: (kind: string) => string; remote: readonly RemoteChannelFacts[] },
    modules: ModulePlatform,
  ): { channels: Channel[]; notes: string[] };
  ensureChannel(
    request: {
      teamId: string;
      slug: string;
      credentialsId: string | null;
      events: readonly string[];
      callbackUrl: string;
      current?: { externalId?: string; events: readonly string[] };
      scope: Record<string, string>;
    },
    modules: ModulePlatform,
  ): Promise<ChannelRegistration | null>;
  removeChannel(
    request: { teamId: string; slug: string; credentialsId: string | null; callbackUrl: string; externalId: string | null; scope: Record<string, string> },
    modules: ModulePlatform,
  ): Promise<void>;
  refreshChannel(request: { teamId: string; slug: string; credentialsId: string | null; externalId: string; scope: Record<string, string> }, modules: ModulePlatform): Promise<void>;
  polledKinds(modules: ModulePlatform): string[];
  pollSecondsOf(adapterType: string, modules: ModulePlatform): number | undefined;
  pollListen(
    request: { teamId: string; triggerId: string; adapterType: string; credentialsId: string | null; movementId: string; config: unknown; checkpoint: unknown; now: string },
    modules: ModulePlatform,
  ): Promise<{ events: Record<string, unknown>[]; checkpoint: unknown }>;
  /** One tick of a schedule, in the version's shape. */
  tickEvent(request: { triggerId: string; due: string; schedule: string }): CarriedEvent;
  /** The one-off map from a carried listen's cursor to the current version's. */
  cursorOnCurrent(heard: HeardSoFar): { cursor: unknown } | undefined;
  readDelivery(request: ReadDeliveryRequest, modules: ModulePlatform): Promise<ReadDeliveryOutcome>;
  gateFiring(request: { teamId: string; adapterType: string; credentialsId: string | null; config: unknown; event: CarriedEvent }, modules: ModulePlatform): Promise<GateAnswer>;
  /** Whether a kept row is a listen under this version. */
  isListenRow(row: Pick<ListenRow, 'config' | 'firedMovementName' | 'source' | 'pin'>): boolean;
  /** The listens a text states, as the version collects them. */
  listenersOf(request: { source: string; pin: string }): readonly CarriedFileListener[];
  readEvent(event: CarriedEvent): CarriedEventReading;
}

export interface CarriedFileListener {
  adapter: string;
  credentialName?: string;
  constructionArgs?: Record<string, string>;
  config: Record<string, unknown>;
  movementName: string;
  alias?: string;
}

/** What a remote adapter of this release stores fetched files in, and the
 *  provider credential it sends. */
type RemoteInput = Parameters<typeof import('movement-engine/public/modules').createRemoteAdapter>[0];
export type RemoteDocuments = RemoteInput['documents'];
export type RemoteCredential = NonNullable<RemoteInput['credential']>;
