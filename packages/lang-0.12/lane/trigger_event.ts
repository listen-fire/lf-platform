import { triggerEventSchema } from '@listen-fire/engine-contracts';
import { z } from 'zod';

/** An event as 0.12 reads it. A source's own timestamp may carry an offset, and
 *  production accepted it (the receipt is replayed as received), so the stored
 *  rows of an old door and a new reading of the same event both run. */
export const lane012EventSchema = triggerEventSchema.extend({ occurredAt: z.string().datetime({ offset: true }).optional() });
