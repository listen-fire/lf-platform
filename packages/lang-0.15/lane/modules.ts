// 0.15's module runtime: the platform's built-in table
// (`adapters/builtin_modules.ts` and `adapters/registry.ts`), each module at
// the version the platform ran with 0.15.3, loaded in process with 0.15's own
// module kit. A segment of a 0.15 run is handed only these instances: a module
// of another release never serves a 0.15 program, since each release reads
// its modules' answers in its own meaning.
//
// The platform hosts them as it hosts its own release's modules (`hostFor`):
// the stored credential, read the way the module's line says and refreshed
// under the platform's one lock, the line's kv, files and identities, and the
// dev loop's fake for the test-harness team. The platform's own modules
// (`@lf/ask`, `@lf/kg`, `@lf/system`, `@lf/native-valuations`) and the units
// are this package's copies of production's, defined with the platform's parts.
//
// A module is loaded on the first install that asks for it, never at import.

import type { Adapter, TriggerType } from '@listen-fire/engine/public/adapter';
import {
  adapterInProcess,
  noCredential,
  type AdapterModuleDefinition,
  type InProcessAdapterModule,
} from '@listen-fire/module-kit';
import { randomUUID } from 'node:crypto';

import { createRemoteAdapter, ownedFilesAdapter } from '@listen-fire/engine/public/modules';

import { askModuleWith } from '../modules/ask';
import { kgModuleWith } from '../modules/kg';
import { nativeValuationsModule } from '../modules/native-valuations';
import { systemModuleWith } from '../modules/system';
import { CRON_ADAPTER_TYPE, createCronAdapter } from '../units/cron';
import { MANUAL_ADAPTER_TYPE, createManualAdapter } from '../units/manual';
import { RemoteAdapterManifestFile } from './remote';
import type { ModuleDeclaration, ModuleInstall, ModulePlatform, PlatformModuleParts } from './run_types';

type ModuleLoader = (parts: PlatformModuleParts) => AdapterModuleDefinition;

/** Production's module lines at 0.15.3, by adapter type: each loads its
 *  module on first use. */
const MODULES: Readonly<Record<string, ModuleLoader>> = {
  dealroom: () => {
    const { dealroomModule }: typeof import('@listen-fire/dealroom') = require('@listen-fire/dealroom');
    return dealroomModule;
  },
  granola: () => {
    const { granolaModule }: typeof import('@listen-fire/granola') = require('@listen-fire/granola');
    return granolaModule;
  },
  evertrace: () => {
    const { evertraceModule }: typeof import('@listen-fire/evertrace') = require('@listen-fire/evertrace');
    return evertraceModule;
  },
  affinity: () => {
    const { affinityModule }: typeof import('@listen-fire/affinity') = require('@listen-fire/affinity');
    return affinityModule;
  },
  airtable: () => {
    const { airtableModule }: typeof import('@listen-fire/airtable') = require('@listen-fire/airtable');
    return airtableModule;
  },
  attio: () => {
    const { attioModule }: typeof import('@listen-fire/attio') = require('@listen-fire/attio');
    return attioModule;
  },
  google_sheets: () => {
    const { googleSheetsModule }: typeof import('@listen-fire/google-sheets') = require('@listen-fire/google-sheets');
    return googleSheetsModule;
  },
  google_drive: () => {
    const { googleDriveModule }: typeof import('@listen-fire/google-drive') = require('@listen-fire/google-drive');
    return googleDriveModule;
  },
  dropbox: () => {
    const { dropboxModule }: typeof import('@listen-fire/dropbox') = require('@listen-fire/dropbox');
    return dropboxModule;
  },
  gmail: () => {
    const { gmailModule }: typeof import('@listen-fire/gmail') = require('@listen-fire/gmail');
    return gmailModule;
  },
  telegram: () => {
    const { telegramModule }: typeof import('@listen-fire/telegram') = require('@listen-fire/telegram');
    return telegramModule;
  },
  slack: (parts) => {
    const { slackModuleWith }: typeof import('@listen-fire/slack') = require('@listen-fire/slack');
    return slackModuleWith({ chat: parts.slackChat, readFile: (ref, ctx) => parts.readFile(ref, ctx.config.tenant) });
  },
  ask: (parts) => askModuleWith({ answerUrl: parts.askAnswerUrl }),
  whatsapp: (parts) => {
    const { whatsappModuleWith }: typeof import('@listen-fire/whatsapp') = require('@listen-fire/whatsapp');
    return whatsappModuleWith({ movementsNumber: parts.whatsappNumber, exposedFileUrl: (url) => parts.isExposedFileUrl(url) });
  },
  system: (parts) => systemModuleWith((ctx) => parts.systemRecords(ctx.config.tenant)),
  'native-valuations': () => nativeValuationsModule,
  mcp: () => {
    const { mcpModule }: typeof import('@listen-fire/mcp') = require('@listen-fire/mcp');
    return mcpModule;
  },
  email: () => {
    const { emailModule }: typeof import('@listen-fire/email') = require('@listen-fire/email');
    return emailModule;
  },
  kg: (parts) =>
    kgModuleWith({
      store: (ctx) => parts.kgStore({ teamId: ctx.config.tenant, credentialsId: ctx.config.credentialRef }),
      changeWebhooks: parts.kgChangeWebhooks,
    }),
};

/** The units, which are this package's own adapters, not modules. */
function unitAdapter(adapterType: string, install: ModuleInstall, parts: PlatformModuleParts): Adapter | undefined {
  switch (adapterType) {
    case MANUAL_ADAPTER_TYPE:
      return createManualAdapter({ teamId: install.teamId, readDocument: parts.readDocument });
    case CRON_ADAPTER_TYPE:
      return createCronAdapter({ teamId: install.teamId });
    default:
      return undefined;
  }
}

/** Every adapter type a 0.15 run can construct. */
export function moduleAdapterTypes(): string[] {
  return [...Object.keys(MODULES), MANUAL_ADAPTER_TYPE, CRON_ADAPTER_TYPE];
}

/** Every adapter type a 0.15 run reaches through a module the platform hosts:
 *  each needs a module line on the platform. */
export function hostedModuleTypes(): string[] {
  return Object.keys(MODULES);
}

function declarationOf(definition: AdapterModuleDefinition): ModuleDeclaration {
  return {
    name: definition.name,
    displayName: definition.manifest.displayName,
    credentials: definition.credentials,
  };
}

/** The module table one run's segments resolve against: each definition
 *  loaded once per table, each install loaded in process with what the
 *  platform hosts it with. */
export function moduleTable(platform: ModulePlatform): {
  resolve(adapterType: string, install: ModuleInstall): Promise<Adapter>;
} {
  const loaded = new Map<string, AdapterModuleDefinition>();
  const definitionOf = (adapterType: string): AdapterModuleDefinition | undefined => {
    const load = MODULES[adapterType];
    if (load === undefined) return undefined;
    let definition = loaded.get(adapterType);
    if (definition === undefined) {
      definition = load(platform.parts);
      loaded.set(adapterType, definition);
    }
    return definition;
  };
  return {
    async resolve(adapterType, install) {
      const unit = unitAdapter(adapterType, install, platform.parts);
      if (unit !== undefined) return unit;
      const definition = definitionOf(adapterType);
      // Anything else is a team's install of a remote adapter, or nothing.
      if (definition === undefined) return remoteAdapterOf(adapterType, install, platform.parts);
      return loadInProcess(definition, adapterType, install, platform).adapter;
    },
  };
}

/** A team's install of a remote adapter, as production built it at 0.15.3
 *  (`adapters/resolve.ts` before 0.16): 0.15's own remote adapter over the
 *  install's stored manifest, read in 0.15's terms, its secret and the
 *  connection's provider credential. One cache scope per instance. */
async function remoteAdapterOf(adapterType: string, install: ModuleInstall, parts: PlatformModuleParts): Promise<Adapter> {
  const pieces = await parts.remoteInstall({
    adapterType,
    teamId: install.teamId,
    ...(install.credentialsId !== undefined ? { credentialsId: install.credentialsId } : {}),
  });
  const parsed = RemoteAdapterManifestFile.safeParse(pieces.manifest);
  if (!parsed.success) {
    throw new Error(`the stored manifest of '${adapterType}' is not one language 0.15 reads: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  const file = parsed.data;
  return createRemoteAdapter({
    config: { adapterType: file.adapterType, teamId: install.teamId, baseUrl: file.baseUrl, authStrategy: file.authStrategy, credentialsId: pieces.credentialsId },
    secret: pieces.secret,
    cacheScopeId: randomUUID(),
    manifest: {
      adapterType: file.adapterType,
      supportedTriggers: file.supportedTriggers.filter(isTriggerType),
      runtimeCapabilities: file.runtimeCapabilities,
      methods: file.methods,
      ...(file.credentials !== undefined ? { credentials: file.credentials } : {}),
      ...(file.limits !== undefined ? { limits: file.limits } : {}),
    },
    documents: pieces.documents,
    ...(pieces.credential !== undefined ? { credential: pieces.credential } : {}),
  });
}

const TRIGGER_TYPES: readonly TriggerType[] = ['extraction', 'snapshot', 'poll', 'changes-feed', 'webhook', 'mutation'];

function isTriggerType(value: string): value is TriggerType {
  return TRIGGER_TYPES.some((type) => type === value);
}

function loadInProcess(
  definition: AdapterModuleDefinition,
  adapterType: string,
  install: ModuleInstall,
  platform: ModulePlatform,
): InProcessAdapterModule {
  const hosted = platform.hostFor({ adapterType, install, declaration: declarationOf(definition) });
  const loaded = adapterInProcess(definition, {
    tenant: install.teamId,
    credential: definition.credentials.length === 0 ? noCredential(`module ${definition.name} declares no credential`) : hosted.credential,
    kv: hosted.kv,
    files: hosted.files,
    log: platform.log,
    ...(hosted.identities !== undefined ? { identities: hosted.identities } : {}),
    ...(hosted.fetch !== undefined ? { fetch: hosted.fetch } : {}),
    ...(hosted.models !== undefined ? { models: hosted.models } : {}),
    ...(hosted.baseUrlOverride !== undefined ? { baseUrlOverride: hosted.baseUrlOverride } : {}),
    ...(install.constructionArgs !== undefined ? { constructionArgs: install.constructionArgs } : {}),
    ...(install.credentialsId !== undefined ? { credentialRef: install.credentialsId } : {}),
    validateResults: platform.validateResults,
  });
  // The files it reads out name this install, as a served module's do.
  const owner = {
    adapterType: definition.manifest.adapterType,
    ...(install.credentialsId !== undefined ? { credentialsId: install.credentialsId } : {}),
    ...(install.constructionArgs !== undefined ? { constructionArgs: install.constructionArgs } : {}),
  };
  return { ...loaded, adapter: ownedFilesAdapter(loaded.adapter, owner) };
}
