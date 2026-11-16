// A trigger id arriving as plain text (a work row's payload) — the boundary
// check that names it as one.

import { z } from 'zod';

import type { TriggerId } from '../generated/kysely/automations/Trigger';

// Any 8-4-4-4-12 hex id (see team_id.ts).
export const triggerIdSchema = z.custom<TriggerId>((value) => z.guid().safeParse(value).success);
