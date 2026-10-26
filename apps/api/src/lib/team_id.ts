// A team id arriving as plain text (a request header, an untyped column) — the
// boundary check that names it as one.

import { z } from 'zod';

import type { TeamId } from '../generated/kysely/core/Team';

// Any 8-4-4-4-12 hex id, as Postgres's `uuid` keeps it: a team id need not
// carry an RFC version and variant (the dev loop's 11111111-2222-3333-4444-…
// does not), and `z.uuid()` would refuse one the database holds.
export const teamIdSchema = z.custom<TeamId>((value) => z.guid().safeParse(value).success);
