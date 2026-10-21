"use client";

import { AlertTriangle } from "lucide-react";
import type { StoryProblem, StoryValidity } from 'legacy-lang';

/**
 * The honesty banners.
 *
 * Every mount of the story shows the script's standing, so the banners travel
 * with the renderer rather than with either page: a picture of a broken program
 * that doesn't say it's broken is the one failure this whole view exists to
 * avoid, and a second mount must not be able to forget it.
 *
 */
export function ValidityNotice({ validity }: { validity: StoryValidity }) {
  if (validity.status === "valid") return null;
  if (validity.status === "unverified") {
    return (
      <Banner tone="warn" title="Some of this hasn’t been double-checked">
        We couldn’t reach one of the connected systems, so parts of this picture
        are what the script says rather than what we confirmed.
      </Banner>
    );
  }
  // The problems themselves are not repeated here: they are already listed,
  // in the script's own words, beside this pane. Saying them twice would put
  // that vocabulary into the one view that is meant to be free of it.
  return (
    <Banner tone="stop" title="This isn’t working right now">
      The script has problems, so this is what it’s trying to do — not what’s
      happening.
    </Banner>
  );
}

export function Problems({ problems }: { problems: StoryProblem[] }) {
  const shown = problems.filter((problem) => problem.severity !== "info").slice(0, 5);
  if (shown.length === 0) return null;
  return (
    <ul className="mb-5 space-y-1">
      {shown.map((problem, index) => (
        <li key={index} className="text-[12px] text-gray-500">
          <span className="mr-1.5 tabular-nums text-gray-400">
            line {problem.span.start.line}
          </span>
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

export function Banner({
  tone,
  title,
  children,
}: {
  tone: "warn" | "stop";
  title: string;
  children: React.ReactNode;
}) {
  const stop = tone === "stop";
  return (
    <div
      className={`mb-4 rounded-xl border px-4 py-3 ${
        stop ? "border-red-100 bg-red-50/70" : "border-amber-100 bg-amber-50/70"
      }`}
    >
      <div
        className={`flex items-center gap-2 text-[12.5px] font-medium ${
          stop ? "text-red-800" : "text-amber-800"
        }`}
      >
        <AlertTriangle size={14} />
        {title}
      </div>
      <p
        className={`mt-1 text-[12px] leading-relaxed ${
          stop ? "text-red-700" : "text-amber-800"
        }`}
      >
        {children}
      </p>
    </div>
  );
}
