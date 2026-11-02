"use client";

/**
 * A copyable line of a program — ``connect `@lf/attio` using acme``,
 * `import { fetch_url } from plugins` — rendered as a small monospace chip.
 * Shared by the Credentials, Adapters, and Plugins pages so every catalogue
 * surface presents what a program writes identically.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CodeSnippet({
  code,
}: {
  /** The line as a program writes it. */
  code: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title={`Copy "${code}"`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (permissions / non-secure context) — the
          // snippet is still visible to copy by hand.
        }
      }}
      className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-500 transition-colors hover:border-gray-300 hover:bg-gray-100"
    >
      <span className="truncate text-gray-700">{code}</span>
      {copied ? (
        <Check size={11} className="shrink-0 text-emerald-500" />
      ) : (
        <Copy
          size={11}
          className="shrink-0 text-gray-300 transition-colors group-hover:text-gray-500"
        />
      )}
    </button>
  );
}
