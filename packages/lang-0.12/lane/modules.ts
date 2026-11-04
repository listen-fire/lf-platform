// 0.12's module runtime: production's built-in table at 0.12.13
// (`adapters/builtin_modules.ts` and `adapters/registry.ts` on main), each
// module at the version production ran, loaded in process with 0.12's own
// module kit. A segment of a 0.12 run is handed only these instances: a module
// of another release never serves a 0.12 program, since each release reads
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

import type { Adapter } from '@listen-fire/engine/public/adapter';
import {
  adapterInProcess,
  noCredential,
  type AdapterModuleDefinition,
  type InProcessAdapterModule,
} from '@listen-fire/module-kit';
import { ownedFilesAdapter } from '@listen-fire/engine/public/modules';

import { askModuleWith } from '../modules/ask';
import { kgModuleWith } from '../modules/kg';
import { nativeValuationsModule } from '../modules/native-valuations';
import { systemModuleWith, type SystemRecords } from '../modules/system';
import { CRON_ADAPTER_TYPE, createCronAdapter } from '../units/cron';
import { MANUAL_ADAPTER_TYPE, createManualAdapter } from '../units/manual';
import type { ModuleDeclaration, ModuleInstall, ModulePlatform, PlatformModuleParts } from './run_types';

type ModuleLoader = (parts: PlatformModuleParts) => AdapterModuleDefinition;

const NOT_POLLED = "the system module's poll reads no records for a language 0.12 automation: this platform does not fire 0.12's listens";

/** The platform's events reach a 0.12 automation only through its listens,
 *  which this platform does not fire for 0.12, so the system module's poll is
 *  handed no records. */
const NO_SYSTEM_RECORDS: SystemRecords = {
  failedRuns: async () => {
    throw new Error(NOT_POLLED);
  },
  storedEvents: async () => {
    throw new Error(NOT_POLLED);
  },
  webBaseUrl: () => {
    throw new Error(NOT_POLLED);
  },
};

/** Production's module lines at 0.12.13, by adapter type: each loads its
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
  system: () => systemModuleWith(NO_SYSTEM_RECORDS),
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

/** Every adapter type a 0.12 run can construct. */
export function moduleAdapterTypes(): string[] {
  return [...Object.keys(MODULES), MANUAL_ADAPTER_TYPE, CRON_ADAPTER_TYPE];
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
  resolve(adapterType: string, install: ModuleInstall): Adapter;
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
    resolve(adapterType, install) {
      const unit = unitAdapter(adapterType, install, platform.parts);
      if (unit !== undefined) return unit;
      const definition = definitionOf(adapterType);
      if (definition === undefined) {
        throw new Error(
          `a language 0.12 automation constructs '${adapterType}', which is not one of 0.12's modules on this platform (${moduleAdapterTypes().join(', ')})`,
        );
      }
      return loadInProcess(definition, adapterType, install, platform).adapter;
    },
  };
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
