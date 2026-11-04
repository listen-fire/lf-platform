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
  credentials: CredentialOwnership;
  /** Billed and metered by the platform. */
  llm: EngineHost['llm'];
  files: EngineHost['files'];
  bindings: EngineHost['park']['bindings'];
  /** The cross-run write locks every version shares. */
  locks: WriteLocks;
  actingUser(input: {
    teamId: string;
    triggerId?: string;
    event: TriggerEvent;
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
  /** What a park is stopped with: the registry's resume refusal for the pin,
   *  when its version does not resume. */
  parkRefusal: string;
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

/** What a remote adapter of this release stores fetched files in, and the
 *  provider credential it sends. */
type RemoteInput = Parameters<typeof import('movement-engine/public/modules').createRemoteAdapter>[0];
export type RemoteDocuments = RemoteInput['documents'];
export type RemoteCredential = NonNullable<RemoteInput['credential']>;
