"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  label: string;
  value: string;
  icon?: React.ReactNode;
  /** A smaller grey line under the label, inside the open dropdown. */
  description?: string;
}

// --- Shared dropdown (portaled to body) ---

interface SelectDropdownProps {
  options: SelectOption[];
  value?: string;
  focusedIndex: number;
  listRef: React.RefObject<HTMLDivElement>;
  anchorRef: React.RefObject<HTMLElement>;
  size?: "default" | "sm";
  search?: string;
  onSearchChange?: (search: string) => void;
  onSelect: (value: string) => void;
  onHover: (index: number) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export function SelectDropdown({
  options,
  value,
  focusedIndex,
  listRef,
  anchorRef,
  size = "default",
  search,
  onSearchChange,
  onSelect,
  onHover,
  onKeyDown,
}: SelectDropdownProps) {
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    direction: "down" | "up";
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Described options take two or three lines each, so four of them need room a plain list does not.
  const tall = options.some((o) => o.description !== undefined);

  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const maxH = tall ? 288 : 192; // max-h-72 : max-h-48
    const direction =
      spaceBelow < maxH && rect.top > spaceBelow ? "up" : "down";
    const width = Math.max(rect.width, size === "sm" ? 140 : 0);
    setPos({
      top: direction === "down" ? rect.bottom + 4 : rect.top - 4,
      left: Math.min(rect.left, window.innerWidth - width - 8),
      width,
      direction,
    });
  }, [anchorRef, size, tall]);

  useEffect(() => {
    if (pos && inputRef.current) {
      inputRef.current.focus();
    }
  }, [pos]);

  if (!pos) return null;

  const dropdown = (
    <div
      ref={listRef}
      className="fixed z-[9999] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
      style={{
        ...(pos.direction === "down"
          ? { top: pos.top }
          : { bottom: window.innerHeight - pos.top }),
        left: pos.left,
        width: pos.width,
      }}
    >
      {onSearchChange != null && (
        <div className="border-b border-gray-100 px-2 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={search ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type to filter..."
            className={`w-full bg-transparent outline-none placeholder:text-gray-300 ${
              size === "sm" ? "text-[12px]" : "text-[13px]"
            }`}
          />
        </div>
      )}
      <div className={`${tall ? "max-h-72" : "max-h-48"} overflow-auto py-1`}>
        {options.length === 0 ? (
          <div
            className={`px-3 py-2 text-gray-400 ${size === "sm" ? "text-[12px]" : "text-[13px]"}`}
          >
            No options
          </div>
        ) : (
          options.map((option, i) => (
            <button
              key={option.value}
              type="button"
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(option.value)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                size === "sm" ? "text-[12px]" : "text-[13px]"
              } ${i === focusedIndex ? "bg-gray-100" : ""} ${option.value === value ? "font-medium text-gray-900" : "text-gray-700"}`}
            >
              {option.icon && <span className="shrink-0">{option.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={option.label}>
                  {option.label}
                </span>
                {option.description && (
                  <span className="mt-0.5 block break-words text-[11.5px] font-normal leading-snug text-gray-400">
                    {option.description}
                  </span>
                )}
              </span>
              {option.value === value && (
                <svg
                  className="ml-auto h-3.5 w-3.5 shrink-0 text-primary"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );

  return createPortal(dropdown, document.body);
}

// --- Shared hook ---

interface UseSelectDropdownOptions {
  options: SelectOption[];
  value?: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
}

export function useSelectDropdown({
  options,
  value,
  disabled,
  onSelect,
}: UseSelectDropdownOptions) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setFocusedIndex(-1);
  }, []);

  const toggle = useCallback(() => {
    if (disabled) return;
    if (open) {
      close();
    } else {
      setOpen(true);
      const idx = options.findIndex((o) => o.value === value);
      setFocusedIndex(idx >= 0 ? idx : 0);
    }
  }, [disabled, open, close, options, value]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        listRef.current &&
        !listRef.current.contains(target)
      ) {
        close();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, close]);

  useEffect(() => {
    if (open && listRef.current && focusedIndex >= 0) {
      const items =
        listRef.current.querySelector(".overflow-auto")?.children ??
        listRef.current.children;
      if (items[focusedIndex]) {
        (items[focusedIndex] as HTMLElement).scrollIntoView({
          block: "nearest",
        });
      }
    }
  }, [focusedIndex, open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        const idx = options.findIndex((o) => o.value === value);
        setFocusedIndex(idx >= 0 ? idx : 0);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < options.length) {
          onSelect(options[focusedIndex].value);
          close();
        }
        break;
      case "Escape":
        e.preventDefault();
        // Closing the list must not also close a dialog the select sits in; that dialog listens on the
        // document, which is also where React listens, so only stopping later listeners too reaches it.
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        close();
        break;
    }
  };

  return {
    open,
    focusedIndex,
    containerRef,
    listRef,
    close,
    toggle,
    handleKeyDown,
    setFocusedIndex,
  };
}

// --- Standard Select ---

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "default" | "sm";
  /** Names the trigger for assistive technology when no visible label sits beside it. */
  ariaLabel?: string;
  testId?: string;
  /** Whether the open list has a filter box; a short list of described choices has no use for one. */
  searchable?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className = "",
  size = "default",
  ariaLabel,
  testId,
  searchable = true,
}: SelectProps) {
  const [search, setSearch] = useState("");

  const filteredOptions = useMemo(() => {
    if (!search) return options;
    const lower = search.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(lower));
  }, [options, search]);

  const {
    open,
    focusedIndex,
    containerRef,
    listRef,
    close,
    toggle,
    handleKeyDown,
    setFocusedIndex,
  } = useSelectDropdown({
    options: filteredOptions,
    value,
    disabled,
    onSelect: onChange,
  });

  const selectedOption = options.find((o) => o.value === value);

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  // Reset focused index when filter changes
  useEffect(() => {
    if (open && filteredOptions.length > 0) {
      setFocusedIndex(0);
    }
  }, [search, open, filteredOptions.length, setFocusedIndex]);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
        className={`flex w-full items-center justify-between rounded-md border border-gray-200 bg-white text-left transition-colors focus:border-gray-400 focus:outline-none disabled:opacity-50 ${
          size === "sm" ? "px-2 py-1.5 text-[12px]" : "px-3 py-2 text-[13px]"
        } ${open ? "border-gray-400" : ""} ${selectedOption ? "text-gray-900" : "text-gray-400"}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selectedOption?.icon && <span className="shrink-0">{selectedOption.icon}</span>}
          <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        </span>
        <svg
          className={`ml-2 h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <SelectDropdown
          options={filteredOptions}
          value={value}
          focusedIndex={focusedIndex}
          listRef={listRef}
          anchorRef={containerRef}
          size={size}
          search={search}
          onSearchChange={searchable ? setSearch : undefined}
          onKeyDown={handleKeyDown}
          onSelect={(v) => {
            onChange(v);
            close();
          }}
          onHover={setFocusedIndex}
        />
      )}
    </div>
  );
}
