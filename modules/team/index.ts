// `@lf-platform/team`: the team's own host functions, as a plugin module. A
// program imports it like any plugin (``import { `@lf-platform/team` as team
// } from plugins``) and calls `team.isMember(m.`User Email`)` in a listen's
// filter. Platform-supplied: only the platform keeps who is on a team, so it
// defines the module over its records (`teamModuleWith`), hosts it in process,
// and serves it to a cloud lf at a route of its own. It is never published.

import { pluginProgramName } from '@listen-fire/engine-contracts/plugin_spec';
import { defineModule, type ModuleContext, type PluginInvocation, type PluginModuleDefinition } from 'module-kit';

import { IS_MEMBER, TEAM_PLUGINS_PACKAGE, USER_FOR } from './plugins';
import type { TeamMember, TeamRecords } from './records';

/** The member a claim names. The claim carries no brand at runtime, so its
 *  kind is read off its shape: an address has an `@`, a number does not. */
async function memberOf(records: TeamRecords, claim: unknown): Promise<TeamMember | null> {
  if (typeof claim !== 'string') throw new Error('@lf-platform/team: a claim is text');
  const text = claim.trim();
  return text.includes('@') ? records.memberByEmail(text.toLowerCase()) : records.memberByPhone(text);
}

function claimOf(input: PluginInvocation): unknown {
  return input.config.claim;
}

export function teamModuleWith(recordsOf: (ctx: ModuleContext) => TeamRecords): PluginModuleDefinition {
  return defineModule({
    kind: 'plugin',
    name: TEAM_PLUGINS_PACKAGE,
    credentials: [],
    plugins: [IS_MEMBER, USER_FOR],
    create: (ctx) => {
      const records = recordsOf(ctx);
      return {
        async invokePlugin(input) {
          switch (pluginProgramName(input.name)) {
            case pluginProgramName(IS_MEMBER.signature.name):
              return { data: { value: (await memberOf(records, claimOf(input))) !== null } };
            case pluginProgramName(USER_FOR.signature.name): {
              const member = await memberOf(records, claimOf(input));
              return {
                data: { value: member === null ? null : { Id: member.id, Email: member.email, Name: member.name, Level: member.level } },
              };
            }
            default:
              throw new Error(`@lf-platform/team has no plugin "${input.name}"`);
          }
        },
      };
    },
  });
}

export * from './plugins';
export * from './records';
