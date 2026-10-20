"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { unitIsMounted } from "@/lib/capabilities";
import { useCapabilities } from "@/lib/capabilities-provider";
import { trpc } from "@/lib/trpc";
import { NodeIcon } from "./node-icon";

function useDebounce(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const capabilities = useCapabilities();

  const { data: results, isFetching } =
    trpc.views.knowledge.graph.globalSearch.useQuery(
      { search: debouncedQuery, limit: 20 },
      {
        enabled: debouncedQuery.length > 0 && unitIsMounted("knowledge", capabilities),
        keepPreviousData: true,
      },
    );

  const items = results ?? [];

  useEffect(() => setSelectedIndex(0), [results]);

  const close = useCallback(() => {
    // Blur so no element holds focus after modal unmounts
    (document.activeElement as HTMLElement)?.blur();
    onClose();
  }, [onClose]);

  const navigate = useCallback(
    (path: string) => {
      router.push(path);
      close();
    },
    [router, close],
  );

  const totalItems = items.length;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, totalItems - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[selectedIndex]) navigate(`/nodes/${items[selectedIndex].nodeId}`);
    } else if (e.key === "Escape") {
      close();
    }
  };

  // Group results by node type
  const grouped = items.reduce<
    Array<{ nodeTypeName: string; nodeTypeId: string; items: typeof items }>
  >((acc, item) => {
    let group = acc.find((g) => g.nodeTypeId === item.nodeTypeId);
    if (!group) {
      group = {
        nodeTypeName: item.nodeTypeName,
        nodeTypeId: item.nodeTypeId,
        items: [],
      };
      acc.push(group);
    }
    group.items.push(item);
    return acc;
  }, []);

  // Flat index for keyboard nav
  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 backdrop-blur-[2px]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="mt-[12vh] w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
          <Search size={18} className="shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={query}
            placeholder="Search everything…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-gray-900 placeholder-gray-400 outline-none"
          />
          {isFetching && (
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-primary" />
          )}
          <kbd className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-400">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {query.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-gray-400">
              Search across all your data
            </div>
          ) : (
            <div className="py-2">
              {/* Node results grouped by type */}
              {items.length === 0 && !isFetching ? (
                <div className="px-4 py-4 text-center text-[13px] text-gray-400">
                  No matching records
                </div>
              ) : (
                grouped.map((group) => (
                  <div key={group.nodeTypeId}>
                    <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
                      {group.nodeTypeName}
                    </div>
                    {group.items.map((item) => {
                      const idx = flatIndex++;
                      return (
                        <button
                          key={item.nodeId}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          onClick={() => navigate(`/nodes/${item.nodeId}`)}
                          className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                            idx === selectedIndex
                              ? "bg-primary-50"
                              : "hover:bg-gray-50"
                          }`}
                        >
                          <NodeIcon
                            nodeTypeId={item.nodeTypeId}
                            iconSvg={item.iconSvg}
                            size={16}
                            className="shrink-0 text-gray-400"
                          />
                          <span className="min-w-0 flex-1 truncate text-[14px] text-gray-900">
                            {item.displayValue ?? item.nodeId.slice(0, 8)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function GlobalSearch({ collapsed }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);

  // Global shortcut: Cmd+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      {collapsed ? (
        <button
          onClick={() => setOpen(true)}
          title="Search (⌘K)"
          className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <Search size={16} />
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="relative flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-100/60 hover:text-gray-900"
        >
          <Search size={16} />
          <span className="truncate">Search</span>
          <kbd className="ml-auto shrink-0 text-[10px] tracking-wide text-gray-300">
            ⌘K
          </kbd>
        </button>
      )}

      {open && <SearchModal onClose={() => setOpen(false)} />}
    </>
  );
}
