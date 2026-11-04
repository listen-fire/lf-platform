// What crosses between the platform and 0.12's run host, in 0.12's terms: the
// request (plain data), the platform's services (functions over plain data),
// and the outcome (plain data). The registry states the same shapes in the
// current release's terms (`@listen-fire/language-versions`), and the
// compiler holds the two to each other where the registry loads this package.
// No object or class of either release crosses: a 0.12 error stops at this
// package's edge as text, and the platform's lease and cancel cross as answers
// to questions, never as the platform's own classes.

import type { CredentialOwnership } from '@listen-fire/engine/public/embed';
import type { ActingUser, DryRunWriteSink, FileRef, ResolveFileRefResult } from '@listen-fire/engine/public/adapter';
import type { EngineHost } from '@listen-fire/engine/public/host';
import type { MovementRunResult } from '@listen-fire/engine/public/movement-engine';
import type { WriteLocks } from '@listen-fire/engine/public/write-locks';
import type { MovementTraceEntry } from '@listen-fire/engine/public/trace';
import type { TriggerEvent } from '@listen-fire/engine/public/inbound';
import type { RunLimitPause } from '@listen-fire/engine/public/movement-engine';
import type { CallbackRecord, RunHostLog, RunHostStore, RunRecords, StepLeaf, StepperFor, runCallbackBody } from '@listen-fire/engine/public/run-host';
import type {
  CredentialFields,
  ModuleCredential,
  ModuleFiles,
  ModuleIdentities,
  ModuleKv,
  ModuleLog,
  ModuleModels,
} from '@listen-fire/module-kit';
import type { KgStore } from '../modules/kg/store';
import type { SlackHosted } from '@listen-fire/slack';

import type { TeamFacts } from './types';

/** One install of a module a run constructs. */
export interface ModuleInstall {
  teamId: string;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}

/** What the platform needs of a module to host it: who it is and the
 *  credentials it declares (the platform reads its stored credential as the
 *  first of them, or the one its line names, and refreshes it under its own
 *  lock). */
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

/** What the platform hosts one install of a module with, as it hosts its own
 *  release's modules: the stored credential (refreshed under the platform's
 *  one lock), the line's kv, files and linked identities, the line's fetch,
 *  and the dev loop's fake for the test-harness team. */
export interface ModuleHostPieces {
  credential: ModuleCredential;
  kv: ModuleKv;
  files: ModuleFiles;
  identities?: ModuleIdentities;
  fetch?: typeof fetch;
  baseUrlOverride?: string;
  models?: ModuleModels;
}

/** The platform's parts the platform's own modules are defined with. */
export interface PlatformModuleParts {
  /** The link an ask is answered at. */
  askAnswerUrl(token: string): string;
  /** The knowledge graph's store for one install. */
  kgStore(install: { teamId: string; credentialsId: string | undefined }): KgStore;
  /** The store's change events reach this deployment as signed webhooks. */
  kgChangeWebhooks: boolean;
  /** The model Slack's composition writes with. */
  slackChat: NonNullable<SlackHosted['chat']>;
  /** The bytes of a `File` value any owner holds, for a team. */
  readFile(ref: FileRef, teamId: string): Promise<{ body: Buffer; contentType?: string }>;
  /** The shared WhatsApp number the platform's Meta app sends from. */
  whatsappNumber: string | null;
  /** Whether a URL is one the platform's Meta door exposes a file at. */
  isExposedFileUrl(url: string): boolean;
  /** A stored document read back for a team, through the store's ownership
   *  check. */
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

/** How the platform hosts 0.12's modules. */
export interface ModulePlatform {
  hostFor(input: { adapterType: string; install: ModuleInstall; declaration: ModuleDeclaration }): ModuleHostPieces;
  parts: PlatformModuleParts;
  log: ModuleLog;
  /** Check every module answer against the protocol's result schema. */
  validateResults: boolean;
}

/** The platform's services a 0.12 segment reaches, each a function over plain
 *  data. */
export interface RunPlatform {
  modules: ModulePlatform;
  /** Where this version's engine reports which engine ran a segment: the run's row. */
  recordEngine(record: { runId: string; engine: 'ts' | 'rust' }): void;
  /** Whether a credential a run names is its team's. */
  credentials: CredentialOwnership;
  /** The platform's model calls, billed and metered by it. */
  llm: EngineHost['llm'];
  files: EngineHost['files'];
  bindings: EngineHost['park']['bindings'];
  /** The platform's cross-run write locks, shared by every version. */
  locks: WriteLocks;
  /** Who acted, by the trigger's own rules and then the source's candidates.
   *  The event stays here: this version's module reads it, in `candidates`. */
  actingUser(input: {
    teamId: string;
    triggerId?: string;
    candidates(): Promise<unknown>;
  }): Promise<ActingUser | null>;
  /** A cancel, asked at each boundary; the lease, asked with it. */
  control: {
    cancelled(): Promise<boolean>;
    cancelledNow(): Promise<boolean>;
    leaseLost(): boolean;
  };
  /** Keeps a record write the run sent in the platform's write ledger, so its
   *  echo is known whichever version the echo reaches. Absent for a rehearsal,
   *  which sends nothing. A throw fails the call after the write was sent. */
  keepWrite?(write: { adapterType: string; recordType: string; externalId: string; at: string }): Promise<void>;
  /** Receives each write a rehearsed target captured. */
  writeSink?: DryRunWriteSink;
  /** Where the segment's parks and callbacks go. Absent for a rehearsal, which
   *  never parks. */
  parks?: CarriedParks;
}

// ── The rows a 0.12 run parks in, and 0.12's rules over them ───────────────

/** How a fenced write came out. Never a throw of the platform's class: this
 *  version throws its own `RunLeaseLost`. */
export type FencedWrite = 'written' | 'lease-lost';

export interface CarriedRunStore {
  parks: Omit<RunHostStore['parks'], 'putLeaf'> & { putLeaf(input: Parameters<RunHostStore['parks']['putLeaf']>[0]): Promise<FencedWrite> };
  joins: Omit<RunHostStore['joins'], 'recordJoin'> & { recordJoin(input: Parameters<RunHostStore['joins']['recordJoin']>[0]): Promise<FencedWrite> };
  correlations: RunHostStore['correlations'];
  leases: RunHostStore['leases'];
  work: RunHostStore['work'];
  sources: RunHostStore['sources'];
}

/** A stored callback, its signature as the row holds it. */
export interface CarriedCallbackRecord extends Omit<CallbackRecord, 'params'> {
  params: { name: string; type: string }[];
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

/** The platform's run rows and records, as 0.12's rules reach them. */
export interface CarriedRunHost {
  store: CarriedRunStore;
  callbacks: CarriedCallbackStore;
  /** An ask await resolves when its ask settles; a withdrawn one closes it. */
  askAwaits: {
    loadResolvable(input: { runId: string }): Promise<{ runId: string; teamId: string; address: string }[]>;
    abandon(input: { runId: string; addresses?: readonly string[] }): Promise<void>;
  };
  runs: RunRecords;
  log: RunHostLog;
}

/** What one segment's parks are written through. */
export interface CarriedParks {
  host: CarriedRunHost;
  /** The run lease the segment steps under: its parks land only under it. */
  fence?: string;
  ensureRun(): Promise<void>;
  markParked(): Promise<void>;
  markLimitPaused(pause: RunLimitPause): Promise<void>;
  callbackUrl(id: string): string;
  notifyWork(): void;
}

/** One segment of a parked run: its state stays this version's, unread by the
 *  platform. */
export type CarriedStep = StepLeaf;
export type CarriedStepperFor = StepperFor;

export type RunCallbackBodyInput = Parameters<typeof runCallbackBody>[2];

/** One segment of a run this version parked: a leaf resumed, a race settled,
 *  or a callback's body. */
export interface ResumeRequest extends Omit<SegmentRequest, 'dryRun'> {
  runId: string;
  /** The parked leaf's state as the row holds it. */
  state: unknown;
  reenter?: boolean;
  deferRaceSettlement?: boolean;
  settleRaceFrameAddress?: string;
  callback?: { values: Record<string, unknown>; callIndex: number };
  priorSpentMicrodollars?: number;
  capBaselineMicrodollars?: number;
  limitPaused?: boolean;
  parkedOnEngine?: 'ts' | 'rust';
}

/** One segment someone started: a run from its first statement. Its event is
 *  JSON in 0.12's own shape, checked against 0.12's event schema here. */
export interface SegmentRequest {
  source: string;
  pin: string;
  movementName?: string;
  event: Readonly<Record<string, unknown>>;
  teamId: string;
  firedAt: string;
  runId?: string;
  costCapMicrodollars?: number;
  dryRun?: boolean;
  team: TeamFacts;
  /** The run's trace, appended as it goes so the platform can publish it
   *  while the run is going. */
  trace?: MovementTraceEntry[];
}

/** What the platform records of a 0.12 event, read with 0.12's schema, or
 *  why 0.12 cannot read it. */
export type EventReading =
  | {
      ok: true;
      record: {
        pipelineInputId: string;
        adapterType: string;
        triggerType: TriggerEvent['triggerType'];
        payload?: unknown;
        recordId?: string;
        occurredAt?: string;
        idempotencyKey?: string;
        actor?: { type: 'user' | 'system' | 'api-token'; id: string | null };
      };
    }
  | { ok: false; reason: string };

/** How a segment ended, as plain data. */
export type SegmentOutcome =
  | { kind: 'ran'; result: MovementRunResult }
  | { kind: 'failed'; code?: string; message: string; partial?: MovementRunResult }
  | { kind: 'lease-lost'; message: string };

export type { CredentialFields };

/** What a remote adapter of this release stores fetched files in, and the
 *  provider credential it sends. */
type RemoteInput = Parameters<typeof import('@listen-fire/engine/public/modules').createRemoteAdapter>[0];
export type RemoteDocuments = RemoteInput['documents'];
export type RemoteCredential = NonNullable<RemoteInput['credential']>;
