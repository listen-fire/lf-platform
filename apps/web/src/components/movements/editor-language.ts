/**
 * The editor's completion, hover and definition for a release pin.
 *
 * A release pin's language service is the wasm, and the wasm is not in the
 * browser: the server answers (`views.movement.{complete,hover,definition}`)
 * against the same run snapshot its lint checks. This module turns those
 * answers into what CodeMirror and the workbench take, and keeps a stale
 * answer from landing. Only TYPES come from movement-lang's service module:
 * the browser never loads the engine artifact.
 *
 * A legacy pin's presentation stays legacy-lang's, in the browser
 * (movement-editor.tsx).
 */

import {
  insertCompletionText,
  pickedCompletion,
  type Completion as CmCompletion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type {
  CompletionItem,
  CompletionKind,
  Completions,
  Definition,
  HoverCard,
  LanguageVersion,
} from "movement-lang";
import type { DefinitionTarget } from "legacy-lang";

import type { EditorLanguageRoute } from "./editor-lint";

/** The server's language service for the editor's program; `signal` aborts a
 *  superseded request. */
export interface LanguageRemote {
  complete: (source: string, offset: number, signal: AbortSignal) => Promise<Completions>;
  hover: (source: string, offset: number, signal: AbortSignal) => Promise<HoverCard | null>;
  definition: (source: string, offset: number, signal: AbortSignal) => Promise<Definition | null>;
}

/**
 * What presents the pin: legacy-lang in the browser under the pin, the
 * server's language service, or nothing. Only the release pin's variant
 * carries the remote, so a legacy or refused pin cannot reach the server.
 */
export type Presentation =
  | { kind: "legacy"; options: { languageVersion: LanguageVersion } }
  | { kind: "installed"; remote: LanguageRemote }
  | null;

export function presentationOf(
  route: EditorLanguageRoute,
  languageVersion: LanguageVersion | undefined,
  remote: LanguageRemote,
): Presentation {
  switch (route.kind) {
    case "legacy":
      // A legacy route always comes with its pin; without one there is no
      // legacy id to read the text under.
      return languageVersion === undefined ? null : { kind: "legacy", options: { languageVersion } };
    case "installed":
      return { kind: "installed", remote };
    case "refused":
      return null;
    default: {
      const unreachable: never = route.kind;
      return unreachable;
    }
  }
}

/** A "+ connect" completion picked: the adapter manifest's declaration, relayed. */
export type ConnectAction = NonNullable<CompletionItem["connectAction"]>;

const COMPLETION_TYPE: Record<CompletionKind, string> = {
  variable: "variable",
  function: "function",
  field: "property",
  edge: "property",
  property: "property",
  module: "namespace",
  namespace: "namespace",
  keyword: "keyword",
  credential: "constant",
  type: "type",
};

/** The edit an item makes when picked with the completion range ending at
 *  `to`. An item with its own range replaces that range, stretched by what
 *  was typed after the answer came. */
export function completionEdit(
  item: CompletionItem,
  answer: Pick<Completions, "to">,
  to: number,
): { from: number; to: number; insert: string } {
  return {
    from: item.from,
    to: item.to + Math.max(0, to - answer.to),
    insert: item.insert ?? item.label,
  };
}

function hasOwnRange(item: CompletionItem, answer: Completions): boolean {
  return item.from !== answer.from || item.to !== answer.to;
}

/**
 * The CodeMirror result for the server's completions at `pos`, or null when
 * the popup should stay closed. `before` is the character before the cursor.
 * Items keep the server's order; CodeMirror ranks them by match.
 */
export function completionResultOf(
  answer: Completions,
  context: {
    pos: number;
    explicit: boolean;
    before: string;
    onConnectAction?: (action: ConnectAction) => void;
  },
): CompletionResult | null {
  if (answer.items.length === 0) return null;
  // Only pop up unprompted when a word or a trigger character is being typed.
  if (!context.explicit && context.pos === answer.from) {
    if (!/[\w.:`[{(,$ ]/.test(context.before) || context.before === " ") return null;
  }
  const options = answer.items.map((item): CmCompletion => {
    const detail = item.detail !== undefined ? { detail: item.detail } : {};
    if (item.connectAction) {
      // A connect entry inserts no text: it strips the partial word and hands
      // the declaration to the app's connect-action handlers, which run the
      // flow and refresh the catalog so the new entry appears.
      const action = item.connectAction;
      return {
        label: item.label,
        type: "constant",
        ...detail,
        apply: (view: EditorView, _completion: CmCompletion, from: number, to: number) => {
          view.dispatch({ changes: { from, to, insert: "" } });
          context.onConnectAction?.(action);
        },
      };
    }
    if (hasOwnRange(item, answer)) {
      return {
        label: item.label,
        type: COMPLETION_TYPE[item.kind],
        ...detail,
        apply: (view: EditorView, completion: CmCompletion, _from: number, to: number) => {
          const edit = completionEdit(item, answer, to);
          view.dispatch({
            ...insertCompletionText(view.state, edit.insert, edit.from, edit.to),
            annotations: pickedCompletion.of(completion),
          });
        },
      };
    }
    return {
      label: item.label,
      type: COMPLETION_TYPE[item.kind],
      ...detail,
      ...(item.insert !== undefined ? { apply: item.insert } : {}),
    };
  });
  return { from: answer.from, options, validFor: /^[\w`#]*$/ };
}

/** Where cmd-click on a definition goes. A name defined in this file has no
 *  page to open, so it stays inert, as legacy offered none. */
export function definitionTargetOf(definition: Definition | null): DefinitionTarget | undefined {
  if (definition === null) return undefined;
  if ("module" in definition) {
    return { kind: definition.module.namespace, name: definition.module.name };
  }
  return definition.file === null ? undefined : { kind: "file", name: definition.file };
}

/** The clickable token at `pos`: a word, or the quoted path of an import line. */
export function navTokenAt(doc: string, pos: number): { from: number; to: number } | undefined {
  const path = importPathTarget(doc, pos);
  if (path) return { from: path.from, to: path.to };
  let from = pos;
  while (from > 0 && /[A-Za-z0-9_]/.test(doc[from - 1] ?? "")) from--;
  let to = pos;
  while (to < doc.length && /[A-Za-z0-9_]/.test(doc[to] ?? "")) to++;
  return from !== to ? { from, to } : undefined;
}

/** The import line's quoted path under `pos`, and the file it names. The path
 *  is not a symbol, so no language service resolves it: the rule is lexical. */
export function importPathTarget(
  doc: string,
  pos: number,
): { from: number; to: number; target: DefinitionTarget } | undefined {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = doc.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = doc.length;
  const line = doc.slice(lineStart, lineEnd);
  if (!/^\s*import\b/.test(line)) return undefined;
  const open = doc.lastIndexOf('"', pos - 1);
  const close = doc.indexOf('"', pos);
  if (open < lineStart || close === -1 || close >= lineEnd) return undefined;
  return { from: open + 1, to: close, target: { kind: "file", name: doc.slice(open + 1, close) } };
}

/**
 * One request at a time: asking again aborts the request before it, and a
 * superseded request answers `null` whatever the server said. A failure of
 * the request still in charge is the caller's.
 */
export function latest(): {
  ask: <T>(request: (signal: AbortSignal) => Promise<T>) => Promise<{ answer: T } | null>;
  cancel: () => void;
} {
  let current: AbortController | null = null;
  return {
    async ask(request) {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      let answer;
      try {
        answer = await request(controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return null;
        throw err;
      }
      if (controller.signal.aborted) return null;
      if (current === controller) current = null;
      return { answer };
    },
    cancel() {
      current?.abort();
      current = null;
    },
  };
}

export type Latest = ReturnType<typeof latest>;

/** The server's hover card at `pos`, or null when there is none or a later
 *  hover superseded this one. */
export async function askHover(
  remote: LanguageRemote,
  requests: Latest,
  source: string,
  pos: number,
): Promise<HoverCard | null> {
  const asked = await requests.ask((signal) => remote.hover(source, pos, signal));
  return asked === null ? null : asked.answer;
}

/** Where the server says cmd-click at `pos` goes (`target` undefined: nowhere),
 *  or null when a later question superseded this one. */
export async function askDefinition(
  remote: LanguageRemote,
  requests: Latest,
  source: string,
  pos: number,
): Promise<{ target: DefinitionTarget | undefined } | null> {
  const asked = await requests.ask((signal) => remote.definition(source, pos, signal));
  return asked === null ? null : { target: definitionTargetOf(asked.answer) };
}
