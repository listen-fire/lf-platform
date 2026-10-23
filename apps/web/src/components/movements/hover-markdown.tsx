"use client";

/**
 * A release pin's hover card is markdown from the language service. It is
 * rendered by its own React root inside the CodeMirror tooltip, which lives
 * outside the page's React tree. Raw HTML in the markdown is dropped: the
 * card shows names and descriptions that come from catalogs, not markup.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createRoot } from "react-dom/client";

export const HOVER_MARKDOWN_CLASS = "cm-hover-markdown";

function HoverMarkdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
      {markdown}
    </ReactMarkdown>
  );
}

/** Renders `markdown` into `dom`; the returned function unmounts it. */
export function mountHoverMarkdown(dom: HTMLElement, markdown: string): () => void {
  dom.classList.add(HOVER_MARKDOWN_CLASS);
  const root = createRoot(dom);
  root.render(<HoverMarkdown markdown={markdown} />);
  // The tooltip can be destroyed while the page's React commits (the editor
  // view is destroyed in an effect cleanup); unmounting a root synchronously
  // there is an error, so the unmount waits for the commit to finish.
  return () => queueMicrotask(() => root.unmount());
}
