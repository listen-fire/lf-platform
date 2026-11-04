"use client";

/**
 * The async-interaction answer surface — the universal renderer (3d, chunk 6b).
 * A human opens `/a/<token>` (delivered by a movement's `(link:)` block) and
 * answers a parked `ask`. The single-use token IS the authorisation — this page
 * needs no login (the responder may have no Listen-Fire account).
 *
 * It fetches the ask detail (`GET /api/asks/<token>/detail`) and renders a
 * control matched to the interaction type:
 *   - Provide  → a typed input (number / date / text) keyed off the result type
 *   - Select   → a checklist; the chosen subset is the answer
 *   - Correct  → an editable table; edit fields + remove records (chunk 6c)
 *   - Check / Choose / Pick / Review → buttons / single-select / acknowledge
 *   - Draft    → a clear placeholder (the rich editor is a later chunk)
 * Submitting POSTs the answer (`POST /api/asks/<token>`) → the workflow resumes.
 *
 * Copy is jargon-free: it shows the question, the data, and plain controls.
 *
 * the universal renderer (6b)
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { AskControl, type AskControlData } from "@/components/asks/ask-controls";

interface AskDetail extends AskControlData {
  richRenderable: boolean;
  paramResolvable: boolean;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; ask: AskDetail }
  | { phase: "gone"; reason: string }
  | { phase: "error"; message: string }
  | { phase: "done"; recorded: string };

const GONE_COPY: Record<string, { title: string; body: string }> = {
  not_found: {
    title: "This link isn’t valid",
    body: "The link may be mistyped, or this request no longer exists.",
  },
  expired: {
    title: "This link has expired",
    body: "Ask the sender for a fresh link to respond.",
  },
  consumed: {
    title: "This link has already been used",
    body: "A response was already recorded through this link.",
  },
  already_resolved: {
    title: "This request has already been answered",
    body: "There’s nothing left to do here — the workflow has moved on.",
  },
};

export default function AnswerPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/asks/${encodeURIComponent(token)}/detail`, {
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setState({ phase: "gone", reason: body.error ?? "not_found" });
          return;
        }
        const ask = (await res.json()) as AskDetail;
        setState({ phase: "ready", ask });
      } catch {
        if (!cancelled) setState({ phase: "error", message: "Could not load this request." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = useCallback(
    async (answer: unknown, recordedLabel: string) => {
      setSubmitting(true);
      try {
        const res = await fetch(`/api/asks/${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ answer }),
        });
        if (res.ok) {
          setState({ phase: "done", recorded: recordedLabel });
          return;
        }
        // Its run can't continue, and nothing was recorded: the server says why.
        if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setState({ phase: "error", message: body.message ?? "This question can't be answered." });
          return;
        }
        // A lost race / expired token comes back 410; surface it cleanly.
        setState({
          phase: "gone",
          reason: res.status === 410 ? "already_resolved" : "error",
        });
      } catch {
        setState({ phase: "error", message: "Could not record your answer. Try again." });
      } finally {
        setSubmitting(false);
      }
    },
    [token],
  );

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-12">
      <Panel>
        <PageContent
          state={state}
          submitting={submitting}
          onSubmit={submit}
        />
      </Panel>
    </main>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-7 shadow-sm">
      {children}
    </div>
  );
}

function PageContent({
  state,
  submitting,
  onSubmit,
}: {
  state: LoadState;
  submitting: boolean;
  onSubmit: (answer: unknown, recordedLabel: string) => void;
}) {
  if (state.phase === "loading") {
    return <p className="text-[13px] text-gray-400">Loading…</p>;
  }
  if (state.phase === "error") {
    return <Message title="Something went wrong" body={state.message} />;
  }
  if (state.phase === "gone") {
    const copy = GONE_COPY[state.reason] ?? {
      title: "This request is no longer available",
      body: "Nothing more is needed here.",
    };
    return <Message title={copy.title} body={copy.body} />;
  }
  if (state.phase === "done") {
    return (
      <Message
        title="Thanks — your answer was recorded"
        body={`We saved your response${state.recorded ? `: ${state.recorded}` : ""}. The workflow will continue shortly. You can close this page.`}
      />
    );
  }
  return <AskForm ask={state.ask} submitting={submitting} onSubmit={onSubmit} />;
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h1 className="text-[17px] font-semibold text-gray-900">{title}</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-gray-500">{body}</p>
    </div>
  );
}


function AskForm({
  ask,
  submitting,
  onSubmit,
}: {
  ask: AskDetail;
  submitting: boolean;
  onSubmit: (answer: unknown, recordedLabel: string) => void;
}) {
  return <AskControl ask={ask} submitting={submitting} variant="page" onSubmit={onSubmit} />;
}
