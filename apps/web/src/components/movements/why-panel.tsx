"use client";

// "Why didn't this fire?" for one stored event: the server judges it afresh
// against each listen on its connection the viewer may read, each time it is
// asked. Shown wherever an event is listed: an automation's activity, and a
// connection's recent deliveries (where an event that set nothing off is found).

import { trpc } from "@/lib/trpc";

const WHY_VERDICT = {
  fires: "it would fire.",
  does_not_fire: "it does not fire.",
  cannot_tell: "it cannot be told.",
  not_heard: "it does not listen for this event.",
} as const;

export interface AskedEvent {
  deliveryId: string;
  arrivalIndex: number;
}

export function WhyPanel({ event }: { event: AskedEvent }) {
  const explained = trpc.views.triggers.explainArrival.useQuery(event, {
    cacheTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="border-t border-gray-100 px-4 py-3" data-testid="why-panel">
      {explained.isLoading && <p className="text-[12px] text-gray-500">Judging it again…</p>}
      {explained.error && (
        <p className="text-[12px] text-red-600" data-testid="why-error">
          {explained.error.message}
        </p>
      )}
      {explained.data?.ok === false && (
        <p className="text-[12px] text-red-600" data-testid="why-refused">
          {explained.data.errors.join(" ")}
        </p>
      )}
      {explained.data?.ok === true && (
        <>
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">Why didn&apos;t this fire?</h3>
          {explained.data.listens.length === 0 ? (
            <p className="text-[12px] text-gray-500" data-testid="why-none">
              No listen you can read hears this event.
            </p>
          ) : (
            <ul className="space-y-2">
              {explained.data.listens.map((entry) => (
                <li key={entry.listen} className="text-[12px] text-gray-700" data-testid={`why-listen-${entry.listen}`}>
                  <span className="font-medium">{entry.automationName}</span>
                  {": "}
                  {WHY_VERDICT[entry.verdict]}
                  {entry.firstFailed !== undefined && (
                    <>
                      {" — the first term that failed: "}
                      <code className="font-mono text-[11px]">{entry.firstFailed}</code>
                    </>
                  )}
                  {entry.reason !== undefined && <span className="text-gray-500">{` (${entry.reason})`}</span>}
                  {entry.hostAnswers.used && (
                    <span className="block text-[11px] text-gray-400" data-testid="why-as-of-now">
                      Asked now ({entry.hostAnswers.asOf}): {entry.hostAnswers.note}.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
