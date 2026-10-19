// The one transport every module kind is reached over: adapter protocol 2's
// HTTP (docs/contracts/adapter-protocol.md). A core module filling a slot is
// a protocol-2 server like any adapter: one POST per method, the envelope
// `{ ok, result }` or `{ ok: false, error }`, its install's settings carried
// on every request. It listens on a Unix socket when it runs on the host's
// box, on loopback TCP where there are no sockets, and on HTTPS when it is
// remote. Its address is written as a base URL: `unix:<socket path>`,
// `http://host:port/` or `https://…`. A module the host starts is told where
// to listen by `MODULE_SOCKET` (else `PORT`), and prints `listening
// unix:<path>` (or `listening <port>`).
//
// The shapes only: a Node client, server and starter are module-runtime's
// `module-wire`.

import { z } from 'zod';

import { CORE_SLOTS, PROTOCOL_VERSION } from '../protocol';

export const SlotRequestEnvelope = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  method: z.string().min(1),
  cacheScopeId: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const SlotError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  /** What a code carries beside its message (the store's `run_lease_lost`: `{ runId }`). */
  data: z.unknown().optional(),
});

export const SlotAnswerEnvelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: SlotError }),
]);

/** What a core module answers `manifest` with. */
export const WireSlotManifest = z.object({
  protocolVersion: z.literal(2),
  name: z.string().min(1),
  kind: z.literal('core'),
  slot: z.enum(CORE_SLOTS),
  methods: z.array(z.string()),
});
export type WireSlotManifestShape = z.infer<typeof WireSlotManifest>;

/** The error code a store answers when a fenced write finds the run's lease gone. */
export const RUN_LEASE_LOST_CODE = 'run_lease_lost';
