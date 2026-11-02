// What the platform gives @lf/slack's module line: its model for the
// composition function, and its redemption of a file any owner holds.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { FileRef } from 'movement-engine/public/adapter';
import type { SlackComposeChat } from '@listen-fire/slack';

import { streamFileRef } from '../../engine/files/retrieve';

/** The composition function's model on the platform: its routed, metered
 *  chat (lazily required: its transitive Prisma dependency stays out of unit
 *  tests that never compose). */
export const platformSlackChat: SlackComposeChat = async (input) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { anthropicChat }: typeof import('../../../../lib/anthropic') = require('../../../../lib/anthropic');
  return anthropicChat(input);
};

/** A `File` value's bytes on the platform: redeemed from whichever owner it
 *  names, for the team the run belongs to. */
export async function platformSlackFile(ref: FileRef, teamId: TeamId): Promise<{ body: Buffer; contentType?: string }> {
  const resolved = await streamFileRef(ref, { teamId });
  const chunks: Buffer[] = [];
  for await (const chunk of resolved.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return { body: Buffer.concat(chunks), ...(resolved.contentType !== undefined ? { contentType: resolved.contentType } : {}) };
}
