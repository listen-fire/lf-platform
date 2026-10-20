// The `slack_response` work kind: the message edit or ephemeral notice the
// Slack interactivity door owes a tap, posted to the payload's `response_url`.
// The door records the tap and queues this row before it answers Slack; the
// post is a live call to Slack, so it runs when the row drains, never after
// the answer, where a restart or a frozen instance would lose it.
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { WorkHandler } from '../work/kinds';

import { logger } from 'movement-engine/public/log';
import { registerWorkKinds } from '../work/drain';
import { enqueueWork } from '../work/store';

declare module '../work/kinds' {
  interface UnitWorkKinds {
    slack_response: true;
  }
}

const slackResponseSchema = z.object({
  responseUrl: z.string().url(),
  body: z.record(z.string(), z.unknown()),
});

export type SlackResponse = z.infer<typeof slackResponseSchema>;

/** Queue one reply. Keyed on the interaction (Slack's `trigger_id`) when it has
 *  one, so a second delivery of the same interaction replies once. A reply that
 *  could never be posted (no usable URL) is refused here, not retried later. */
export async function enqueueSlackResponse(input: { response: SlackResponse; interactionId?: string }): Promise<void> {
  await enqueueWork({
    kind: 'slack_response',
    key: `slack_response:${input.interactionId ?? randomUUID()}`,
    payload: slackResponseSchema.parse(input.response),
  });
}

// Slack honours a response_url for 30 minutes and five posts, so a reply that
// has failed this many times is past saving.
const MAX_SLACK_RESPONSE_ATTEMPTS = 5;

export const slackResponseHandler: WorkHandler = {
  async run(payload, ctx) {
    const parsed = slackResponseSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error('[slack/actions] unreadable reply row dropped', { error: parsed.error.message });
      return;
    }
    const { responseUrl, body } = parsed.data;
    try {
      const response = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // A 4xx (an expired or spent response_url) will not get better.
      if (response.status >= 500) throw new Error(`Slack answered ${response.status}`);
      if (!response.ok) logger.warn('[slack/actions] response_url refused the reply', { status: response.status });
    } catch (error) {
      if (ctx.attempts < MAX_SLACK_RESPONSE_ATTEMPTS) throw error;
      logger.warn('[slack/actions] giving up on the response_url reply', {
        attempts: ctx.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

export function registerSlackResponseWork(): void {
  registerWorkKinds([{ kind: 'slack_response', handler: slackResponseHandler }]);
}
