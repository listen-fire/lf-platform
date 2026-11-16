// How a connection's recent delivery reads in its list: what it set off, and
// which of its events can be asked about.

import type { RouterOutputs } from "@/lib/trpc";

export type ConnectionDelivery = RouterOutputs["views"]["connections"]["deliveries"][number];

/** What the delivery set off when it arrived, of the listens the viewer may read. */
export function firedLine(fired: ConnectionDelivery["fired"]): string {
  if (fired.length === 0) return "Set nothing off you can read";
  return `Set off ${[...new Set(fired.map((listen) => listen.automationName))].join(", ")}`;
}

/** How many events it brought, in words; a request that does not say is one event as far as anyone can ask. */
export function eventCountLine(eventCount: number | null): string {
  if (eventCount === null) return "events not counted";
  return eventCount === 1 ? "1 event" : `${eventCount} events`;
}

/** The places of the events that can be judged again: the first only, when the delivery does not say how many it brought. */
export function askableEvents(eventCount: number | null): number[] {
  return Array.from({ length: eventCount ?? 1 }, (_, index) => index);
}
