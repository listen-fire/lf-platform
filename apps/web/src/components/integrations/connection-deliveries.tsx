"use client";

// A connection's recent deliveries, beside the connection itself: an event that
// set nothing off reached no automation, so no automation's activity lists it,
// and this is where it is found. Each can be asked "why didn't this fire?", and
// run with by a writer of an automation that listens there.

import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui";
import { WhyPanel, type AskedEvent } from "@/components/movements/why-panel";

import { askableEvents, eventCountLine, firedLine } from "./delivery-lines";

const BUTTON =
  "shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40";

export function ConnectionDeliveries({ connectionId, name }: { connectionId: string; name: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.views.connections.deliveries.useQuery({ id: connectionId });
  const runWith = trpc.views.movement.runWithEvent.useMutation({
    onSuccess: () => void utils.views.connections.deliveries.invalidate({ id: connectionId }),
  });
  const [why, setWhy] = useState<AskedEvent | null>(null);
  // The event of each delivery the viewer picked, when it brought more than one.
  const [picked, setPicked] = useState<Record<string, number>>({});

  if (isLoading) return <p className="mt-2 text-[12px] text-gray-500">Reading recent deliveries…</p>;
  if (error) {
    return (
      <p className="mt-2 text-[12px] text-red-600" data-testid="connection-deliveries-error">
        {error.message}
      </p>
    );
  }
  const deliveries = data ?? [];

  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-white" data-testid={`connection-deliveries-${name}`}>
      {deliveries.length === 0 ? (
        <p className="px-4 py-2.5 text-[12px] text-gray-500">Nothing has arrived for this account yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {deliveries.map((delivery) => {
            const events = askableEvents(delivery.eventCount);
            const arrivalIndex = picked[delivery.deliveryId] ?? 0;
            return (
              <li key={delivery.deliveryId} data-testid={`delivery-${delivery.deliveryId}`}>
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <Badge tone={delivery.fired.length === 0 ? "amber" : "emerald"}>{firedLine(delivery.fired)}</Badge>
                  <span className="min-w-0 flex-1 text-[11px] text-gray-400">
                    {new Date(delivery.receivedAt).toLocaleString()} · {eventCountLine(delivery.eventCount)}
                  </span>
                  {events.length > 1 && (
                    <select
                      value={arrivalIndex}
                      onChange={(e) => setPicked({ ...picked, [delivery.deliveryId]: Number(e.target.value) })}
                      className="rounded-md border border-gray-200 px-1.5 py-0.5 text-[12px] text-gray-600"
                      aria-label="Which event"
                    >
                      {events.map((index) => (
                        <option key={index} value={index}>{`Event ${index + 1}`}</option>
                      ))}
                    </select>
                  )}
                  {events.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setWhy({ deliveryId: delivery.deliveryId, arrivalIndex })}
                      className={BUTTON}
                      data-testid={`delivery-why-${delivery.deliveryId}`}
                      title="Judge this event again against the listens on this account and say what stopped each."
                    >
                      Why didn&apos;t this fire?
                    </button>
                  )}
                  {events.length > 0 &&
                    delivery.runnable.map((automation) => (
                      <button
                        key={automation.automationId}
                        type="button"
                        disabled={runWith.isLoading}
                        onClick={() => runWith.mutate({ id: automation.automationId, deliveryId: delivery.deliveryId, arrivalIndex })}
                        className={BUTTON}
                        data-testid={`delivery-run-${delivery.deliveryId}-${automation.automationName}`}
                        title={`Start ${automation.automationName} with this event's data, without its filters.`}
                      >
                        Run {automation.automationName} with this event
                      </button>
                    ))}
                </div>
                {why?.deliveryId === delivery.deliveryId && <WhyPanel key={`${why.deliveryId}:${why.arrivalIndex}`} event={why} />}
                {runWith.variables?.deliveryId === delivery.deliveryId && (
                  <>
                    {runWith.data?.ok === false && (
                      <div className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600" data-testid="delivery-run-refused">
                        {runWith.data.errors.join(" ")}
                      </div>
                    )}
                    {runWith.data?.ok === true && (
                      <div className="border-t border-gray-100 px-4 py-2 text-[12px] text-gray-600" data-testid="delivery-run-started">
                        {runWith.data.runIds.length === 1 ? "One run queued." : `${runWith.data.runIds.length} runs queued.`}
                      </div>
                    )}
                    {runWith.error && (
                      <div className="border-t border-gray-100 px-4 py-2 text-[12px] text-red-600" data-testid="delivery-run-error">
                        {runWith.error.message}
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
