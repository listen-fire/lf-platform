// How the platform hosts 0.15's modules, in 0.15's terms: plain data and
// functions over it. The registry states the same shapes in the current
// release's terms (`@listen-fire/language-versions`), and the compiler holds
// the two to each other where the registry loads this package.

import type { ActingUser } from '@listen-fire/engine-contracts';
import type { DryRunWriteSink, FileRef, ResolveFileRefResult } from '@listen-fire/engine/public/adapter';
import type { CredentialOwnership, EngineHost } from '@listen-fire/engine/public/host';
import type { TriggerEvent } from '@listen-fire/engine/public/inbound';
import type { MovementRunResult } from '@listen-fire/engine/public/movement-engine';
import type { MovementTraceEntry } from '@listen-fire/engine/public/trace';
import type { WriteLocks } from '@listen-fire/engine/public/write-locks';
import type {
  ModuleCredential,
  ModuleFiles,
  ModuleIdentities,
  ModuleKv,
  ModuleLog,
  ModuleModels,
} from '@listen-fire/module-kit';
import type { KgStore } from '../modules/kg/store';
import type { SystemRecords } from '../modules/system';
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
  /** What the system module reads of one team's own events. */
  systemRecords(tenant: string): SystemRecords;
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

/** How the platform hosts 0.15's modules. */
export interface ModulePlatform {
  hostFor(input: { adapterType: string; install: ModuleInstall; declaration: ModuleDeclaration }): ModuleHostPieces;
  parts: PlatformModuleParts;
  log: ModuleLog;
  /** Check every module answer against the protocol's result schema. */
  validateResults: boolean;
}

type RemoteInput = Parameters<typeof import('@listen-fire/engine/public/modules').createRemoteAdapter>[0];
export type RemoteDocuments = RemoteInput['documents'];
export type RemoteCredential = NonNullable<RemoteInput['credential']>;

// ── A 0.15 segment on the platform's run host ──────────────────────────────

/** The instance a segment holds for a file's owner, as a byte reader needs
 *  it. */
export interface CarriedFileOwner {
  resolveFileRef?(input: { ref: FileRef }): Promise<ResolveFileRefResult>;
}

/** The platform's services a 0.15 segment reaches, each a function over plain
 *  data. Its parks go into the platform's own run host (`park`), which 0.15's
 *  engine writes in the shapes this release's does. */
export interface RunPlatform {
  modules: ModulePlatform;
  /** Where the engine reports which engine ran a segment: the run's row. */
  recordEngine(record: { runId: string; engine: 'ts' | 'rust' }): void;
  credentials: CredentialOwnership;
  /** Billed and metered by the platform. */
  llm: EngineHost['llm'];
  files: EngineHost['files'];
  /** Runs `call` with `owners` as where the platform's byte readers find a
   *  file's owner: 0.15's own scope is not the one they read. */
  withFileOwners<T>(
    owners: (owner: { adapterType: string; credentialsId?: string; constructionArgs?: Record<string, string> }) => CarriedFileOwner | undefined,
    call: () => Promise<T>,
  ): Promise<T>;
  bindings: EngineHost['park']['bindings'];
  locks: WriteLocks;
  /** Who acted, by the trigger's own rules and then the source module's
   *  candidates, which 0.15's module reads off its own event. */
  actingUser(input: { teamId: string; triggerId?: string; candidates(): Promise<unknown> }): Promise<ActingUser | null>;
  /** A cancel, asked at each boundary; the lease, asked with it. */
  control: {
    cancelled(): Promise<boolean>;
    cancelledNow(): Promise<boolean>;
    leaseLost(): boolean;
  };
  /** The write ledger; absent for a rehearsal, which sends nothing. */
  keepWrite?(write: { adapterType: string; recordType: string; externalId: string; at: string }): Promise<void>;
  writeSink?: DryRunWriteSink;
  /** The platform's run host's park family; absent for a rehearsal. */
  park?: Omit<EngineHost['park'], 'bindings'>;
}

/** One segment someone started. Its event is JSON in 0.15's shape, checked
 *  against 0.15's event schema here. */
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
  trace?: MovementTraceEntry[];
  triggerMark?: number;
}

/** One segment of a run 0.15 parked: a leaf resumed or a race settled. */
export interface ResumeRequest extends Omit<SegmentRequest, 'dryRun'> {
  runId: string;
  /** The parked leaf's state as the row holds it. */
  state: unknown;
  answer?: unknown;
  reenter?: boolean;
  deferRaceSettlement?: boolean;
  settleRaceFrameAddress?: string;
  priorSpentMicrodollars?: number;
  capBaselineMicrodollars?: number;
  limitPaused?: boolean;
  parkedOnEngine?: 'ts' | 'rust';
}

export type SegmentOutcome =
  | { kind: 'ran'; result: MovementRunResult }
  | { kind: 'failed'; code?: string; message: string; partial?: MovementRunResult }
  | { kind: 'lease-lost'; message: string };

/** What the platform records of a 0.15 event, read with 0.15's schema, or why
 *  0.15 cannot read it. */
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
