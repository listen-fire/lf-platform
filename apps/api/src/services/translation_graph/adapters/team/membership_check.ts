import { pluginProgramName } from 'movement-engine/public/plugins';
import { pluginKey } from 'movement-lang';
import { IS_MEMBER, TEAM_PLUGINS_PACKAGE } from '@lf-platform/team/plugins';

/** The catalog key of the host function that limits a listen to the team: what an upgrade's fix for an open listen calls. */
export const TEAM_MEMBERSHIP_CHECK = pluginKey(TEAM_PLUGINS_PACKAGE, pluginProgramName(IS_MEMBER.signature.name));
