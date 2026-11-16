// A user id arriving as plain text (an opaque column, a notification payload) —
// the boundary check that names it as one.

import { z } from 'zod';

import type { UserId } from '../generated/kysely/core/User';

// Any 8-4-4-4-12 hex id, as Postgres's `uuid` keeps it (see team_id.ts).
export const userIdSchema = z.custom<UserId>((value) => z.guid().safeParse(value).success);
