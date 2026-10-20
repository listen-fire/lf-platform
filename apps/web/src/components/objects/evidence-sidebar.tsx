// evidence sidebar for full pages
"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";

const EVIDENCE_TYPE_STYLES: Record<string, string> = {
  extraction: "bg-blue-100 text-blue-700",
  user_edit: "bg-purple-100 text-purple-700",
  retrieval: "bg-green-100 text-green-700",
  input_mapping: "bg-gray-100 text-gray-600",
};

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  extraction: "Extraction",
  user_edit: "User edit",
  retrieval: "Retrieval",
  input_mapping: "Input mapping",
};

const CHANGE_SOURCE_STYLES: Record<string, string> = {
  pipeline: "bg-blue-100 text-blue-700",
  user_edit: "bg-purple-100 text-purple-700",
  agent: "bg-amber-100 text-amber-700",
  api: "bg-gray-100 text-gray-600",
  mcp: "bg-green-100 text-green-700",
};

const CHANGE_SOURCE_LABELS: Record<string, string> = {
  pipeline: "Pipeline",
  user_edit: "User edit",
  agent: "Agent",
  api: "API",
  mcp: "MCP",
};

function formatDate(date: Date | string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatChangeValue(val: unknown): string {
  if (val === null || val === undefined) return "\u2014";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (obj.text !== undefined) return String(obj.text);
    if (obj.number !== undefined) return String(obj.number);
    if (obj.boolean !== undefined) return obj.boolean ? "Yes" : "No";
    if (obj.date !== undefined) {
      return new Date(obj.date as string).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
    if (obj.json !== undefined) return JSON.stringify(obj.json);
  }
  return String(val);
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  URL: "Web page",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  FILE: "File",
  TEXT: "Text",
};

function SourceExpansion({ resourceId }: { resourceId: string }) {
  const { data: source, isLoading } =
    trpc.views.knowledge.graph.getEvidenceSource.useQuery({ resourceId });

  if (isLoading) {
    return <div className="mt-1.5 h-12 animate-pulse rounded bg-gray-50" />;
  }
  if (!source) return null;

  return (
    <div className="mt-1.5 rounded-md border border-gray-150 bg-gray-50 p-2">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
          {RESOURCE_TYPE_LABELS[source.type] ?? source.type}
        </span>
        <span className="truncate text-[11px] font-medium text-gray-700">
          {source.name}
        </span>
      </div>
      {source.url && (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1 block truncate text-[11px] text-blue-500 hover:underline"
        >
          {source.url}
        </a>
      )}
      {source.content && (
        <div className="max-h-36 overflow-y-auto rounded border border-gray-200 bg-white p-1.5">
          <pre className="whitespace-pre-wrap text-[10px] leading-relaxed text-gray-600">
            {source.content.length > 2000
              ? source.content.slice(0, 2000) + "\u2026"
              : source.content}
          </pre>
        </div>
      )}
    </div>
  );
}

export function EvidenceSidebar({
  propertyId,
  propertyName,
  onClose,
  onRegenerate,
}: {
  propertyId: string;
  propertyName: string;
  onClose: () => void;
  onRegenerate?: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: timeline, isLoading } =
    trpc.views.knowledge.graph.getPropertyTimeline.useQuery({ propertyId });
  const regenerate = trpc.views.knowledge.graph.regeneratePropertyValue.useMutation({
    onSuccess: () => {
      utils.views.knowledge.graph.getPropertyTimeline.invalidate({ propertyId });
      onRegenerate?.();
    },
  });
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  const toggleSource = (id: string) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-gray-200 bg-white">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-gray-200 px-4">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-gray-900">
            {propertyName}
          </h3>
          <p className="text-[10px] uppercase tracking-wider text-gray-400">
            History
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => regenerate.mutate({ propertyId })}
            disabled={regenerate.isLoading || !timeline?.some((e) => e.type === "evidence")}
            title="Regenerate value from evidence"
            className="shrink-0 rounded p-1 text-gray-400 transition-colors hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg
              className={`h-4 w-4 ${regenerate.isLoading ? "animate-spin" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        <button
          onClick={onClose}
          className="shrink-0 rounded p-1 text-gray-400 transition-colors hover:text-gray-600"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-50" />
            ))}
          </div>
        ) : timeline && timeline.length > 0 ? (
          <div className="relative space-y-0">
            {/* Timeline line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-200" />

            {timeline.map((entry) => (
              <div key={entry.id} className="relative flex gap-3 pb-4">
                {/* Dot */}
                <div
                  className={`relative z-10 mt-1 h-[15px] w-[15px] shrink-0 rounded-full border-2 ${
                    entry.type === "evidence"
                      ? "border-blue-300 bg-blue-50"
                      : "border-purple-300 bg-purple-50"
                  }`}
                />

                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-1.5">
                    {entry.type === "evidence" ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${EVIDENCE_TYPE_STYLES[entry.evidenceType] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {EVIDENCE_TYPE_LABELS[entry.evidenceType] ?? entry.evidenceType}
                      </span>
                    ) : (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${CHANGE_SOURCE_STYLES[entry.source] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {CHANGE_SOURCE_LABELS[entry.source] ?? entry.source}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400">
                      {formatDate(entry.createdAt)}
                    </span>
                  </div>

                  {entry.type === "evidence" ? (
                    <div>
                      {entry.context ? (
                        <p className="text-[12px] leading-relaxed text-gray-700">
                          {[
                            entry.context.adapterLabel,
                            entry.context.triggerType,
                          ]
                            .filter(Boolean)
                            .join(" · ") || entry.description}
                        </p>
                      ) : (
                        entry.description && (
                          <p className="text-[12px] leading-relaxed text-gray-700">
                            {entry.description}
                          </p>
                        )
                      )}
                      {entry.excerpt && (
                        <blockquote className="mt-1 border-l-2 border-blue-200 pl-2 text-[11px] italic leading-relaxed text-gray-500">
                          {entry.excerpt}
                        </blockquote>
                      )}
                      {entry.resourceId && (
                        <>
                          <button
                            onClick={() => toggleSource(entry.id)}
                            className="mt-1 flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-600"
                          >
                            <svg
                              className={`h-3 w-3 transition-transform ${expandedSources.has(entry.id) ? "rotate-90" : ""}`}
                              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                              strokeLinecap="round" strokeLinejoin="round"
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                            {expandedSources.has(entry.id) ? "Hide source" : "View source"}
                          </button>
                          {expandedSources.has(entry.id) && (
                            <SourceExpansion resourceId={entry.resourceId} />
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div className="text-[12px] text-gray-700">
                        {entry.kind === "property_set" ? (
                          <span>
                            {formatChangeValue(entry.oldValue) === "\u2014"
                              ? `Set to ${formatChangeValue(entry.newValue)}`
                              : `${formatChangeValue(entry.oldValue)} \u2192 ${formatChangeValue(entry.newValue)}`}
                          </span>
                        ) : entry.kind === "property_cleared" ? (
                          <span>Cleared</span>
                        ) : (
                          <span>{entry.kind}</span>
                        )}
                      </div>
                      {entry.createdByName && (
                        <span className="text-[10px] text-gray-400">
                          by {entry.createdByName}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center">
            <p className="text-[13px] italic text-gray-400">No history</p>
          </div>
        )}
      </div>
    </div>
  );
}
