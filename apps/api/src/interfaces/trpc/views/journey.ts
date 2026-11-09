import { z } from 'zod';
import { sql } from 'kysely';

import type { UserId } from '../../../generated/kysely/core/User';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { trpc } from '../trpc';
import { getQb } from '../../../lib/kysely';
import { JOURNEY_LAUNCH_AT } from '../../../lib/journey';
import { platformAdminProcedure } from '../procedures';
import { encodeCursor, decodeCursor } from './cursor';
import { EXEMPT, decidesEach } from '../../access_route';

const subjectSchema = z.enum(['user', 'team']);

export const USER_STEPS = [
  'signed_up',
  'mcp_connected',
  'first_mcp_call',
  'first_automation_saved',
] as const;

export const TEAM_STEPS = ['created', 'first_automation_saved', 'first_run'] as const;

// Union of every step across both subjects, for validating `stuckAt` against
// the schema before checking it belongs to the given subject (see `list`'s
// `superRefine`). Duplicates (e.g. `first_automation_saved`) are harmless —
// z.enum only cares about set membership.
const STUCK_AT_STEPS = [
  'signed_up',
  'mcp_connected',
  'first_mcp_call',
  'first_automation_saved',
  'created',
  'first_run',
] as const;

const journeyRouter = (procedure: typeof trpc.procedure) => {
  const adminProcedure = platformAdminProcedure(procedure);

  return trpc.router({
    funnel: adminProcedure
      .input(z.object({ subject: subjectSchema }))
      .query(async ({ input }) => {
        if (input.subject === 'user') {
          // Internal/test/staff accounts (see `views/testHarness.ts`'s
          // `is_internal: true` seed) are excluded — irrelevant at scale but
          // material while the real cohort is single-digit. `is_internal` is
          // `boolean ... NOT NULL DEFAULT false` (schema.sql), so `= false`
          // is exact — no `is not true` nullability dance needed.
          const row = await getQb(['core.user', 'user_journey'])
            .selectFrom('core.user as u')
            .leftJoin('user_journey as j', 'j.user_id', 'u.id')
            .where('u.created_at', '>=', JOURNEY_LAUNCH_AT)
            .where('u.is_internal', '=', false)
            .select([
              sql<number>`(count(*))::int`.as('signed_up'),
              sql<number>`(count(*) filter (where j.mcp_connected_at is not null))::int`.as(
                'mcp_connected',
              ),
              sql<number>`(count(*) filter (where j.first_mcp_call_at is not null))::int`.as(
                'first_mcp_call',
              ),
              sql<number>`(count(*) filter (where j.first_automation_saved_at is not null))::int`.as(
                'first_automation_saved',
              ),
            ])
            .executeTakeFirstOrThrow();
          return {
            subject: 'user' as const,
            steps: USER_STEPS,
            counts: row,
            launchAt: JOURNEY_LAUNCH_AT,
          };
        }

        // No team-level "internal" signal exists (no `team.is_internal`, no
        // established "all members internal" convention elsewhere in the
        // codebase) — left unfiltered rather than inventing one. See the
        // journey-final-fixes report for the investigation.
        const row = await getQb(['core.team', 'team_journey'])
          .selectFrom('core.team as t')
          .leftJoin('team_journey as j', 'j.team_id', 't.id')
          .where('t.created_at', '>=', JOURNEY_LAUNCH_AT)
          .select([
            sql<number>`(count(*))::int`.as('created'),
            sql<number>`(count(*) filter (where j.first_automation_saved_at is not null))::int`.as(
              'first_automation_saved',
            ),
            sql<number>`(count(*) filter (where j.first_run_at is not null))::int`.as('first_run'),
          ])
          .executeTakeFirstOrThrow();
        return {
          subject: 'team' as const,
          steps: TEAM_STEPS,
          counts: row,
          launchAt: JOURNEY_LAUNCH_AT,
        };
      }),

    list: adminProcedure
      .input(
        z
          .object({
            subject: subjectSchema,
            stuckAt: z.enum(STUCK_AT_STEPS).nullish(),
            limit: z.number().min(1).max(100).default(50),
            cursor: z.string().optional(),
          })
          .superRefine((input, ctx) => {
            if (!input.stuckAt) return;
            const validSteps: readonly string[] =
              input.subject === 'user' ? USER_STEPS : TEAM_STEPS;
            if (!validSteps.includes(input.stuckAt)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['stuckAt'],
                message: `stuckAt "${input.stuckAt}" is not a valid step for subject "${input.subject}"`,
              });
            }
          }),
      )
      .query(async ({ input }) => {
        const cursor = input.cursor ? decodeCursor(input.cursor) : null;

        if (input.subject === 'user') {
          let q = getQb(['core.user', 'user_journey'])
            .selectFrom('core.user as u')
            .leftJoin('user_journey as j', 'j.user_id', 'u.id')
            .where('u.created_at', '>=', JOURNEY_LAUNCH_AT)
            .where('u.is_internal', '=', false)
            .select([
              'u.id as id',
              'u.username as label',
              'u.created_at as created_at',
              'j.mcp_connected_at',
              'j.first_mcp_call_at',
              'j.first_mcp_tool',
              'j.first_automation_saved_at',
            ])
            .orderBy('u.created_at', 'desc')
            .orderBy('u.id', 'desc')
            .limit(input.limit + 1);

          // "Stuck at step N" = the LAST milestone reached is N — reached N (or
          // N is the baseline signed_up step) and none of the LATER milestones
          // are set. Milestone columns are written independently by separate
          // taps (see lib/journey/record.ts), so they are not guaranteed
          // monotonic — not because the web UI can light up
          // first_automation_saved without MCP (it can't: that user milestone
          // is gated to MCP saves only, see provision.ts's `viaMcp` check and
          // save.unit.test.ts), but because of residual holes: a hand-minted
          // API key or `X-On-Behalf-Of` call can still reach a later milestone
          // without an earlier one, and each milestone write is fire-and-forget
          // (see the `void ... .catch(logger.warn)` taps), so a failed write
          // can strand an earlier milestone unset while a later one lands. In
          // particular, if the first_mcp_call write fails but the save's own
          // write succeeds, first_automation_saved_at ends up set against a
          // null first_mcp_call_at — rare, self-correcting in aggregate, and
          // not worth guarding against here. Checking only "hasn't reached the
          // next step" (as opposed to "hasn't reached any later step") would
          // misfile such a user as stuck at signed_up even though they cleared
          // the funnel.
          if (input.stuckAt === 'signed_up') {
            q = q
              .where('j.mcp_connected_at', 'is', null)
              .where('j.first_mcp_call_at', 'is', null)
              .where('j.first_automation_saved_at', 'is', null);
          }
          if (input.stuckAt === 'mcp_connected') {
            q = q
              .where('j.mcp_connected_at', 'is not', null)
              .where('j.first_mcp_call_at', 'is', null)
              .where('j.first_automation_saved_at', 'is', null);
          }
          if (input.stuckAt === 'first_mcp_call') {
            q = q
              .where('j.first_mcp_call_at', 'is not', null)
              .where('j.first_automation_saved_at', 'is', null);
          }
          if (input.stuckAt === 'first_automation_saved') {
            q = q.where('j.first_automation_saved_at', 'is not', null);
          }

          if (cursor) {
            q = q.where((eb) =>
              eb.or([
                eb('u.created_at', '<', cursor.createdAt),
                eb.and([
                  eb('u.created_at', '=', cursor.createdAt),
                  eb('u.id', '<', cursor.id as UserId),
                ]),
              ]),
            );
          }

          const rows = await q.execute();
          const hasMore = rows.length > input.limit;
          const items = hasMore ? rows.slice(0, input.limit) : rows;
          const last = items[items.length - 1];
          const nextCursor =
            hasMore && last
              ? encodeCursor({
                  createdAt: new Date(last.created_at).toISOString(),
                  id: last.id,
                })
              : null;

          return { rows: items, nextCursor };
        }

        let q = getQb(['core.team', 'team_journey'])
          .selectFrom('core.team as t')
          .leftJoin('team_journey as j', 'j.team_id', 't.id')
          .where('t.created_at', '>=', JOURNEY_LAUNCH_AT)
          .select([
            't.id as id',
            't.name as label',
            't.created_at as created_at',
            'j.first_automation_saved_at',
            'j.first_run_at',
          ])
          .orderBy('t.created_at', 'desc')
          .orderBy('t.id', 'desc')
          .limit(input.limit + 1);

        // Same "last milestone reached" logic as the user branch above.
        if (input.stuckAt === 'created') {
          q = q
            .where('j.first_automation_saved_at', 'is', null)
            .where('j.first_run_at', 'is', null);
        }
        if (input.stuckAt === 'first_automation_saved') {
          q = q
            .where('j.first_automation_saved_at', 'is not', null)
            .where('j.first_run_at', 'is', null);
        }
        if (input.stuckAt === 'first_run') {
          q = q.where('j.first_run_at', 'is not', null);
        }

        if (cursor) {
          q = q.where((eb) =>
            eb.or([
              eb('t.created_at', '<', cursor.createdAt),
              eb.and([
                eb('t.created_at', '=', cursor.createdAt),
                eb('t.id', '<', cursor.id as TeamId),
              ]),
            ]),
          );
        }

        const rows = await q.execute();
        const hasMore = rows.length > input.limit;
        const items = hasMore ? rows.slice(0, input.limit) : rows;
        const last = items[items.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeCursor({
                createdAt: new Date(last.created_at).toISOString(),
                id: last.id,
              })
            : null;

        return { rows: items, nextCursor };
      }),
  });
};

decidesEach('journey', {
  funnel: EXEMPT.platformAdmin,
  list: EXEMPT.platformAdmin,
});

export { journeyRouter };
