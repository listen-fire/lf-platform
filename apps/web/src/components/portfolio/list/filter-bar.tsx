"use client";

/**
 * Rebuilt-thin filter bar (V-20) — replaces apps/app's 487-LOC FilterSelect
 * token combobox with a plain Tailwind bar: name search, year, country,
 * entity type, fund, and a "raised between" range. The config popover
 * (grouping/sort/currency/value-as-of) lives in ./config-panel.
 *
 * apps/app wired the name debounce but never applied its result to state —
 * the search box looked live but silently did nothing. Fixed here: typing
 * updates `filter.name` after 300ms.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Search } from "lucide-react";
import { getCountryByCode } from "platform-constants/countries";

import { trpc } from "@/lib/trpc";
import { toApiFilter, toApiConfig } from "./api-params";
import { ENTITY_TYPE_FILTER_OPTIONS, type PortfolioConfig, type PortfolioFilter } from "./types";

// No width here on purpose: Tailwind emits `w-full` *after* `w-auto` and `w-48`,
// so a width baked into the shared class beats every per-control override and
// stacks the whole bar vertically. Each control states its own width.
const inputClass =
  "rounded-md border border-gray-200 px-2 py-1.5 text-[13px] focus:border-gray-400 focus:outline-none";

export function FilterBar({
  filter,
  setFilter,
  config,
  setConfig,
}: {
  filter: PortfolioFilter;
  setFilter: (updater: (f: PortfolioFilter) => PortfolioFilter) => void;
  config: PortfolioConfig;
  setConfig: (updater: (c: PortfolioConfig) => PortfolioConfig) => void;
}) {
  const [nameInput, setNameInput] = useState(filter.name ?? "");

  useEffect(() => {
    setNameInput(filter.name ?? "");
  }, [filter.name]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = nameInput || null;
      setFilter((f) => (f.name === next ? f : { ...f, name: next }));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 300);
    return () => clearTimeout(handle);
  }, [nameInput]);

  const baseParams = {
    filter: toApiFilter(filter),
    config: toApiConfig(config),
  };

  const { data: yearOptions } = trpc.views.investments.getYearOptions.useQuery({
    ...baseParams,
    filter: { ...baseParams.filter, fromDate: undefined, toDate: undefined },
    scope: config.aggregation,
  });

  const { data: countryOptions } = trpc.views.investments.getCountryOptions.useQuery({
    ...baseParams,
    filter: { ...baseParams.filter, geos: undefined },
  });

  const { data: portfolios, isLoading: portfoliosLoading } =
    trpc.views.portfolio.company.getAllPortfolios.useQuery();
  // Slimmed to {id,name} outside JSX — mapping the full LegalEntity result
  // (its `linkedinData: JsonValue` field is recursive) blows up TS's
  // instantiation depth (TS2589) when done through `.map`'s inferred
  // callback; a for-of with destructuring only touches the two properties
  // we need.
  const portfolioOptions = useMemo(() => {
    const options: { id: string; name: string }[] = [];
    for (const { id, name } of portfolios ?? []) {
      options.push({ id, name: name ?? "???" });
    }
    return options;
  }, [portfolios]);

  const from = filter.fromDate ? new Date(filter.fromDate) : null;
  const to = filter.toDate ? new Date(filter.toDate) : null;
  const yearValue =
    from &&
    to &&
    from.getUTCMonth() === 0 &&
    from.getUTCDate() === 1 &&
    to.getUTCMonth() === 0 &&
    to.getUTCDate() === 1 &&
    to.getUTCFullYear() - from.getUTCFullYear() === 1
      ? from.getUTCFullYear().toString()
      : "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder="Search companies"
          className={`${inputClass} w-48 pl-7`}
        />
      </div>

      <select
        value={yearValue}
        onChange={(e) => {
          const year = e.target.value;
          setFilter((f) =>
            year
              ? { ...f, fromDate: `${year}-01-01`, toDate: `${Number(year) + 1}-01-01` }
              : { ...f, fromDate: null, toDate: null },
          );
        }}
        className={`${inputClass} w-auto`}
      >
        <option value="">
          {config.aggregation === "company" ? "First investment year" : "Investment year"}
        </option>
        {yearOptions?.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>

      <select
        value={filter.geos[0] ?? ""}
        onChange={(e) =>
          setFilter((f) => ({ ...f, geos: e.target.value ? [e.target.value] : [] }))
        }
        className={`${inputClass} w-auto`}
      >
        <option value="">Country</option>
        {countryOptions
          ?.map((code) => ({ code, title: getCountryByCode(code)?.title ?? code }))
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((c) => (
            <option key={c.code} value={c.code}>
              {c.title}
            </option>
          ))}
      </select>

      <div className="flex overflow-hidden rounded-md border border-gray-200">
        {ENTITY_TYPE_FILTER_OPTIONS.map((opt) => {
          const active = opt.entityTypes.some((et) => filter.entityTypes.includes(et));
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() =>
                setFilter((f) => ({
                  ...f,
                  entityTypes: active
                    ? f.entityTypes.filter((et) => !opt.entityTypes.includes(et))
                    : [...f.entityTypes, ...opt.entityTypes],
                }))
              }
              className={`px-2.5 py-1.5 text-[13px] transition-colors ${
                active ? "bg-primary-50 text-primary-700" : "bg-white text-gray-500 hover:bg-gray-50"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <select
        disabled={portfoliosLoading}
        value={config.portfolioIds[0] ?? ""}
        onChange={(e) =>
          setConfig((c) => ({ ...c, portfolioIds: e.target.value ? [e.target.value] : [] }))
        }
        className={`${inputClass} w-auto`}
      >
        <option value="">Fund</option>
        {portfolioOptions.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <RaisedBetween filter={filter} setFilter={setFilter} />
    </div>
  );
}

function RaisedBetween({
  filter,
  setFilter,
}: {
  filter: PortfolioFilter;
  setFilter: (updater: (f: PortfolioFilter) => PortfolioFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const active = Boolean(filter.raisedFrom || filter.raisedTo);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] ${
          active ? "border-primary-200 bg-primary-50 text-primary-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
        }`}
      >
        <Calendar size={14} />
        {active ? `Raised ${filter.raisedFrom ?? "…"} → ${filter.raisedTo ?? "…"}` : "Raised between"}
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-56 rounded-xl border border-gray-100 bg-white p-3 shadow-lg">
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-gray-400">From</span>
              <input
                type="date"
                value={filter.raisedFrom ?? ""}
                max={filter.raisedTo ?? undefined}
                onChange={(e) => setFilter((f) => ({ ...f, raisedFrom: e.target.value || null }))}
                className={`${inputClass} w-full`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-gray-400">To</span>
              <input
                type="date"
                value={filter.raisedTo ?? ""}
                min={filter.raisedFrom ?? undefined}
                onChange={(e) => setFilter((f) => ({ ...f, raisedTo: e.target.value || null }))}
                className={`${inputClass} w-full`}
              />
            </label>
            <button
              type="button"
              disabled={!active}
              onClick={() => setFilter((f) => ({ ...f, raisedFrom: null, raisedTo: null }))}
              className="self-end text-[12px] text-gray-400 hover:text-gray-600 disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
