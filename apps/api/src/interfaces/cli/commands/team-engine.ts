import { Command, command, metadata, option, Options } from 'clime';
import { z } from 'zod';

import { globalQb } from '../../../lib/kysely';
import { readTeamEngine, TEAM_ENGINES } from '../../../services/lf_engine/team_engine';
import { switchTeamEngine } from '../../../services/lf_engine/switch';

class TeamEngineOptions extends Options {
  @option({ description: 'Team id', required: true })
  team!: string;

  @option({ description: `Switch the team to this engine (${TEAM_ENGINES.join(' or ')}). Without it, print the current one.` })
  set?: string;
}

const engineSchema = z.enum(TEAM_ENGINES);

/**
 * The team engine switch for an installation without the web app: the same
 * switch, and the same audit entry, as the toggle on the team's settings page.
 * The switch is recorded with no user, since the CLI acts as the operator.
 */
@command({ description: "Print or switch which engine runs a team's automations (platform or lf)" })
export default class extends Command {
  @metadata
  async execute(options: TeamEngineOptions): Promise<void> {
    try {
      await this.run(options);
    } finally {
      await globalQb.destroy();
    }
  }

  private async run(options: TeamEngineOptions): Promise<void> {
    if (options.set === undefined) {
      const setting = await readTeamEngine(options.team);
      console.warn(
        `team ${options.team}: ${setting.engine}` +
          (setting.changedAt ? ` (switched ${setting.changedAt.toISOString()})` : ' (never switched)'),
      );
      return;
    }
    const engine = engineSchema.safeParse(options.set);
    if (!engine.success) {
      throw new Error(`--set must be ${TEAM_ENGINES.join(' or ')}, not "${options.set}".`);
    }
    const result = await switchTeamEngine(options.team, { engine: engine.data, changedBy: null });
    console.warn(`team ${options.team}: ${result.engine}${result.changed ? '' : ' (already)'}`);
  }
}
