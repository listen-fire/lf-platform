'use client';

import { useEffect, useState } from 'react';
import { initParser, isParserReady, neverAsAny } from 'movement-lang';
import { initFrozenParser, isFrozenParserReady } from 'legacy-lang/wasm/frozen_parser';

/** Where the browser fetches the parsers: next.config.ts copies each artifact
 *  into public/ under a content-hashed name and injects its URL. The frozen
 *  one reads the versions the language release no longer serves. */
export const PARSER_URL = requiredUrl('NEXT_PUBLIC_PARSER_URL', process.env.NEXT_PUBLIC_PARSER_URL);
export const FROZEN_PARSER_URL = requiredUrl('NEXT_PUBLIC_FROZEN_PARSER_URL', process.env.NEXT_PUBLIC_FROZEN_PARSER_URL);

function requiredUrl(name: string, url: string | undefined): string {
  if (url === undefined) throw new Error(`${name} is not set; next.config.ts injects it`);
  return url;
}

let loading: Promise<void> | undefined;

/** Loads both parsers once per page, however many providers mount; a failed
 *  load is forgotten so "Try again" fetches afresh. */
export function loadParser(): Promise<void> {
  loading ??= Promise.all([initParser(PARSER_URL), initFrozenParser(FROZEN_PARSER_URL)]).then(
    () => undefined,
    (failure: unknown) => {
      loading = undefined;
      throw failure;
    },
  );
  return loading;
}

function parsersReady(): boolean {
  return isParserReady() && isFrozenParserReady();
}

type ParserState = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; failure: unknown };

/**
 * Renders its children only once the movement parsers have loaded. The
 * editors and the listeners panel parse during their first render, and a
 * browser can only load the parser asynchronously (it refuses a large
 * synchronous WASM compile on the main thread), so until then this renders
 * nothing. It wraps only the movement routes, so a failed load shows its
 * own error there and never reaches the pages that do not parse.
 */
export function ParserProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ParserState>(() =>
    parsersReady() ? { status: 'ready' } : { status: 'loading' },
  );

  useEffect(() => {
    if (state.status !== 'loading') return;
    let mounted = true;
    loadParser().then(
      () => mounted && setState({ status: 'ready' }),
      (failure: unknown) => mounted && setState({ status: 'failed', failure }),
    );
    return () => {
      mounted = false;
    };
  }, [state.status]);

  switch (state.status) {
    case 'loading':
      return null;
    case 'ready':
      return <>{children}</>;
    case 'failed':
      return (
        <div role="alert" className="p-6 text-sm text-gray-700">
          <p>The movement editor could not load its parser.</p>
          <p className="mt-1 text-gray-500">{state.failure instanceof Error ? state.failure.message : String(state.failure)}</p>
          <button
            type="button"
            className="mt-3 rounded border border-gray-300 px-3 py-1.5 text-gray-900 hover:bg-gray-50"
            onClick={() => setState({ status: 'loading' })}
          >
            Try again
          </button>
        </div>
      );
    default:
      return neverAsAny(state);
  }
}
