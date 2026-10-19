import { z } from 'zod';

// Granularity levels the adapter node types declare they support
// (per-message coarsest, per-founder finest; iterate fans out over an edge).
const granularitySchema = z.enum(['per-message', 'per-company', 'per-founder', 'iterate']);
export type Granularity = z.infer<typeof granularitySchema>;

// Duration schema for deduplication windows
export const durationSchema = z.object({
  years: z.number().optional(),
  months: z.number().optional(),
  weeks: z.number().optional(),
  days: z.number().optional(),
  hours: z.number().optional(),
  minutes: z.number().optional(),
  seconds: z.number().optional(),
});
export type Duration = z.infer<typeof durationSchema>;
