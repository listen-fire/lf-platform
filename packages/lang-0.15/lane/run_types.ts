// How the platform hosts 0.15's modules, in 0.15's terms: plain data and
// functions over it. The registry states the same shapes in the current
// release's terms (`@listen-fire/language-versions`), and the compiler holds
// the two to each other where the registry loads this package.

import type { FileRef, ResolveFileRefResult } from '@listen-fire/engine/public/adapter';
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
