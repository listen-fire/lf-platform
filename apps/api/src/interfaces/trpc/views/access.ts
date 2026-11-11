// Who may reach one automation or one connection, as the web reads and
// changes it: an automation's read, write and fire lists, a connection's use
// list. The same decisions as REST `setAccess`: reading the lists needs read
// on the automation (use on the connection), changing one needs write (use);
// a team admin may read and change every thing's lists on their team. What the
// caller may not see is answered as what is not there.

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { currentPrincipal } from 'principal';
import { neverAsAny } from 'movement-engine/public/types';

import type { StatedVerb, Target, Thing } from '../../../services/access/statement';

import { automationView, connectionView, type AccessView, type Shown } from '../../../services/access/listing';
import {
  StatementRefusedError,
  adminOf,
  maySeeStatement,
  setStatement,
  type StatementRefusal,
} from '../../../services/access/decide';
import { GranteesInput } from '../../../services/access/stated_input';
import { CHANGE_STATEMENT, decidesEach, type Decision } from '../../access_route';
import { cannotChange } from '../access';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { trpc } from '../trpc';

export type { AccessView };

/**
 * A change of a list: the thing as it now stands, or why the list was refused.
 * The page says each reason in its own words, never the decision's text,
 * which is written for agents.
 */
export type SetResult = { ok: true; view: AccessView } | { ok: false; refusal: StatementRefusal };

const AUTOMATION_VERBS = ['read', 'write', 'fire'] as const satisfies readonly StatedVerb<'automation'>[];

const NOT_FOUND: Record<Thing, string> = {
  automation: 'That automation was not found.',
  connection: 'That connection was not found.',
};

const READ_ONLY_CONNECTION_MESSAGE = 'You may use this connection but not change who may.';

function notFound(thing: Thing): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND[thing] });
}

async function automationViewOrNotFound(id: string): Promise<Shown<'automation'>> {
  const view = await automationView(id);
  if (view === undefined) throw notFound('automation');
  return view;
}

async function connectionViewOrNotFound(id: string): Promise<Shown<'connection'>> {
  const view = await connectionView(id);
  if (view === undefined) throw notFound('connection');
  return view;
}

/** A list the decision refused, as the page is told it. */
function refusedList(error: unknown): SetResult {
  if (error instanceof StatementRefusedError) return { ok: false, refusal: error.refusal };
  throw error;
}

const ThingInput = z.object({ thing: z.enum(['automation', 'connection']), id: z.string() });

const SetInput = z.discriminatedUnion('thing', [
  z.object({ thing: z.literal('automation'), id: z.string(), verb: z.enum(AUTOMATION_VERBS), grantees: GranteesInput }),
  z.object({ thing: z.literal('connection'), id: z.string(), verb: z.literal('use'), grantees: GranteesInput }),
]);

const accessRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Who may reach the thing, and whether the caller may change that. */
    get: userProcedure.input(ThingInput).query(async ({ input }): Promise<AccessView> => {
      if (!(await maySeeStatement(currentPrincipal(), { thing: input.thing, id: input.id }))) throw notFound(input.thing);
      switch (input.thing) {
        case 'automation':
          return automationViewOrNotFound(input.id);
        case 'connection':
          return connectionViewOrNotFound(input.id);
        default:
          return neverAsAny(input.thing);
      }
    }),

    /** Replace one of the thing's lists, as the caller chose it. Answers with the thing as it now stands. */
    set: userProcedure.input(SetInput).mutation(async ({ input }): Promise<SetResult> => {
      const principal = currentPrincipal();
      switch (input.thing) {
        case 'automation': {
          const target: Target<'automation'> = { thing: 'automation', id: input.id };
          if (!(await adminOf(principal, target)) && (await cannotChange(input.id))) throw notFound('automation');
          try {
            await setStatement(principal, { target, verb: input.verb, grantees: input.grantees });
          } catch (error) {
            return refusedList(error);
          }
          return { ok: true, view: await automationViewOrNotFound(input.id) };
        }
        case 'connection': {
          const target: Target<'connection'> = { thing: 'connection', id: input.id };
          if (!(await maySeeStatement(principal, target))) throw notFound('connection');
          try {
            await setStatement(principal, { target, verb: input.verb, grantees: input.grantees });
          } catch (error) {
            // The caller may use it (an admin is never refused), so the one way this refuses them is that they only read on its team.
            if (error instanceof StatementRefusedError && error.refusal === 'not_allowed') {
              throw new TRPCError({ code: 'FORBIDDEN', message: READ_ONLY_CONNECTION_MESSAGE });
            }
            return refusedList(error);
          }
          return { ok: true, view: await connectionViewOrNotFound(input.id) };
        }
        default:
          return neverAsAny(input);
      }
    }),
  });
};

/** Reading who may reach a thing: whoever may read the automation or use the connection (or a team admin). */
const READS_THE_THING = { byTarget: { automation: 'read', connection: 'use' } } satisfies Decision;

decidesEach('access', {
  get: READS_THE_THING,
  set: CHANGE_STATEMENT,
});

export { accessRouter };
