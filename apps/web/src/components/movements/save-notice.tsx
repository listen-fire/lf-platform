"use client";

// What a save tells its author beside the editor about who may reach what:
// why a save was not theirs to make (nothing was stored), and what a save
// that went through will surprise them with. Drawn from props alone.

import { AlertCircle } from "lucide-react";

/** Why a person's save was refused. The server's `SaveRefusal` (save_access.ts). */
export type SaveRefusal =
  | { kind: "read_only" }
  | { kind: "name_taken"; name: string }
  | { kind: "name_gone"; name: string }
  | { kind: "missing_statement"; missing: ("read" | "write" | "fire")[] }
  | { kind: "statement"; message: string }
  | { kind: "connections"; connections: { connection: string; file: string }[]; unreadableFiles: string[] };

export function SaveRefusalNotice({
  refused,
  onChooseAccess,
}: {
  refused: SaveRefusal;
  /** Opens the choice of who may reach a new automation. */
  onChooseAccess: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3.5" data-testid={`save-refused-${refused.kind}`}>
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-800">
        <AlertCircle size={15} />
        Not saved
      </div>
      <div className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-amber-700">
        <RefusalBody refused={refused} onChooseAccess={onChooseAccess} />
      </div>
    </div>
  );
}

function RefusalBody({ refused, onChooseAccess }: { refused: SaveRefusal; onChooseAccess: () => void }) {
  switch (refused.kind) {
    case "read_only":
      return <p>You may read this automation but not change it.</p>;
    case "name_taken":
      return <p>The name &ldquo;{refused.name}&rdquo; is taken. Save under another name.</p>;
    case "name_gone":
      return (
        <p>
          The automation named &ldquo;{refused.name}&rdquo; was deleted while you were saving it, so nothing was saved. Save
          again to create it.
        </p>
      );
    case "missing_statement":
      return (
        <>
          <p>A new automation needs to say who may see, change and set it off.</p>
          <button
            type="button"
            onClick={onChooseAccess}
            className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-100"
          >
            Choose who may reach it
          </button>
        </>
      );
    case "statement":
      return <p>{refused.message}</p>;
    case "connections":
      return (
        <>
          <p>This file names connections you may not use, or that do not exist:</p>
          <ul className="space-y-1" data-testid="save-refused-connection-list">
            {refused.connections.map((c) => (
              <li key={`${c.file}\u0000${c.connection}`}>
                <span className="font-medium">{c.connection}</span>
                <span className="text-amber-600"> named in </span>
                <span className="font-mono text-[11px]">{c.file}</span>
              </li>
            ))}
            {refused.unreadableFiles.map((file) => (
              <li key={`unreadable\u0000${file}`}>
                <span className="font-mono text-[11px]">{file}</span>
                <span className="text-amber-600">, a file you can&apos;t read, names one</span>
              </li>
            ))}
          </ul>
          <p>A save may name only connections you may use. Ask someone who may use them to share them with you.</p>
        </>
      );
    default: {
      const unreachable: never = refused;
      return unreachable;
    }
  }
}

/** What a save that went through would surprise its author with. */
export function SaveWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-2.5 space-y-1.5 border-t border-green-100 pt-2.5 text-[12px] leading-relaxed text-amber-700" data-testid="save-warnings">
      {warnings.map((warning, i) => (
        <li key={i} className="flex gap-1.5">
          <AlertCircle size={13} className="mt-[2px] shrink-0" />
          <span>{warning}</span>
        </li>
      ))}
    </ul>
  );
}
