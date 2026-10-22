"use client";

/**
 * The holdings table itself (V-20: the list page's value is its query and
 * columns, not a hand-rolled card list) — ported from apps/app's
 * Investments.tsx InvestmentCard/Stats, ~1:1 on the data read, rebuilt as
 * table rows on apps/web's automations/page.tsx table idiom.
 */

import { useState } from "react";
import Link from "next/link";
import { getCountryByCode } from "platform-constants/countries";

import { Badge } from "@/components/ui";
import { formatDate, formatMoney, formatTvpi } from "@/components/portfolio";
import { CompanyLogo } from "./company-logo";
import { OwnerPicker } from "./owner-picker";
import { InvestmentDetailModal } from "./investment-detail-modal";
import type { Aggregation, Investment, PortfolioConfig } from "./types";

function hostnameOf(url: string): string {
  return url.replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/$/, "");
}

// `investments`/`acquired_by`/`investors` are typed as always-arrays by the
// codegen, but they're built by bare `JSONB_AGG(...)` (no `coalesce(..,'[]')`
// the way `jsonArrayFrom` gets it) over a joined/filtered row set — Postgres
// aggregates return SQL NULL, not `[]`, when zero rows qualify. The type
// lies; guard every read.
function investmentDates(investment: Investment): Investment["investments"] {
  return investment.investments ?? [];
}

function isFollowOn(investment: Investment): boolean {
  const dates = investmentDates(investment);
  if (!investment.first_invested_at || dates.length === 0) return false;
  const minDate = dates
    .map((i) => formatDate(new Date(i.date), "yyyy-MM-dd"))
    .sort((a, b) => a.localeCompare(b))[0];
  const globalFirst = formatDate(new Date(investment.first_invested_at), "yyyy-MM-dd");
  return minDate !== globalFirst;
}

export function HoldingsTable({
  investments,
  aggregation,
  showDetails,
  config,
}: {
  investments: Investment[];
  aggregation: Aggregation;
  showDetails: boolean;
  /** What the list was asked for — the modal re-runs the same valuation to
   *  narrate one line of it, so it has to ask on the same terms. */
  config: PortfolioConfig;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50/50 text-[11px] uppercase tracking-wider text-gray-400">
            <th className="py-2.5 pl-4 pr-4 font-medium">Company</th>
            <th className="py-2.5 pr-4 font-medium">Funds</th>
            <th className="py-2.5 pr-4 font-medium">
              {aggregation === "company" ? "First invested" : "Investment date"}
            </th>
            <th className="py-2.5 pr-4 text-right font-medium">Invested</th>
            <th className="py-2.5 pr-4 text-right font-medium">Retained</th>
            <th className="py-2.5 pr-4 text-right font-medium">Realized</th>
            <th className="py-2.5 pr-4 text-right font-medium">MOIC</th>
            <th className="py-2.5 pr-4 text-right font-medium">Owner</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {investments.map((investment) => (
            <HoldingRow
              key={investment.legal_entity_id + (investmentDates(investment)[0]?.id ?? "")}
              investment={investment}
              aggregation={aggregation}
              showDetails={showDetails}
              config={config}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingRow({
  investment,
  aggregation,
  showDetails,
  config,
}: {
  investment: Investment;
  aggregation: Aggregation;
  showDetails: boolean;
  config: PortfolioConfig;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const isExited = Boolean(investment.is_exited);
  const followOn = aggregation === "company" && isFollowOn(investment);
  const investmentDate =
    aggregation === "company" ? investment.first_invested_at : (investmentDates(investment)[0]?.date ?? null);

  return (
    <>
      <tr className="transition-colors hover:bg-gray-50">
        <td className="py-3 pl-4 pr-4">
          <div className="flex items-center gap-2.5">
            <CompanyLogo url={investment.personal_website} alt={investment.name} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {investment.slug ? (
                  <Link
                    href={`/portfolio/c/${investment.slug}`}
                    prefetch={false}
                    className="truncate font-medium text-gray-900 hover:underline"
                  >
                    {investment.name}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-gray-900">{investment.name}</span>
                )}
                {isExited && <Badge tone="gray">Exited</Badge>}
                {followOn && <Badge tone="violet">Follow-on</Badge>}
              </div>
              <div className="truncate text-[12px] text-gray-400">
                {[
                  investment.personal_website ? hostnameOf(investment.personal_website) : null,
                  investment.country ? (getCountryByCode(investment.country)?.title ?? investment.country) : null,
                ]
                  .filter((v): v is string => Boolean(v))
                  .join(" · ")}
              </div>
            </div>
          </div>
        </td>
        <td className="py-3 pr-4 text-gray-500">
          <FundsCell investment={investment} />
        </td>
        <td className="py-3 pr-4 text-gray-500">
          {investmentDate ? formatDate(new Date(investmentDate), "MMM yyyy") : "-"}
        </td>
        <MoneyCell
          value={formatMoney(investment.totalInvested, {
            currency: investment.currentValueCurrency,
            isAbbrFormat: true, maximumFractionDigits: 2,
          })}
          onClick={() => setModalOpen(true)}
        />
        <MoneyCell
          value={formatMoney(investment.unrealizedValue, {
            currency: investment.currentValueCurrency,
            isAbbrFormat: true, maximumFractionDigits: 2,
          })}
          onClick={() => setModalOpen(true)}
        />
        <MoneyCell
          value={formatMoney(investment.realizedValue, {
            currency: investment.currentValueCurrency,
            isAbbrFormat: true, maximumFractionDigits: 2,
          })}
          onClick={() => setModalOpen(true)}
        />
        <MoneyCell value={formatTvpi(investment.moic)} onClick={() => setModalOpen(true)} />
        <td className="py-3 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-end">
            <OwnerPicker
              legalEntityId={investment.legal_entity_id}
              ownerName={investment.point_of_contact.name}
              ownerImageUrl={investment.point_of_contact.image_url}
            />
          </div>
        </td>
      </tr>
      {showDetails && <DetailRow investment={investment} />}
      <InvestmentDetailModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        investments={investment.investments}
        config={config}
      />
    </>
  );
}

function MoneyCell({ value, onClick }: { value: string; onClick: () => void }) {
  return (
    <td className="py-3 pr-4 text-right font-medium text-gray-800">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="hover:underline"
        title="How this was calculated"
      >
        {value}
      </button>
    </td>
  );
}

function FundsCell({ investment }: { investment: Investment }) {
  if (investment.acquired_by_legal_entity_id && investment.acquirer.slug) {
    return (
      <span>
        acquired by{" "}
        <Link
          href={`/portfolio/c/${investment.acquirer.slug}`}
          prefetch={false}
          className="text-primary hover:underline"
        >
          {investment.acquirer.name}
        </Link>
      </span>
    );
  }
  // `acquired_by` is aggregated with a `filterWhere(id is not null)` — when
  // every candidate row is filtered out, JSONB_AGG returns SQL NULL rather
  // than `[]` for the whole group (this was NewCo's crash: no acquisitions
  // means a null array, not an empty one).
  const acquiredBy = investment.acquired_by ?? [];
  if (acquiredBy.length > 0) {
    return (
      <span>
        acquired{" "}
        {acquiredBy.map((a, i) => (
          <span key={a.id}>
            {i > 0 && ", "}
            {a.slug ? (
              <Link href={`/portfolio/c/${a.slug}`} prefetch={false} className="text-primary hover:underline">
                {a.name}
              </Link>
            ) : (
              a.name
            )}
          </span>
        ))}
      </span>
    );
  }
  const investors = investment.investors ?? [];
  if (investors.length === 0) {
    return <span className="text-gray-300">—</span>;
  }
  return <span>{investors.map((i) => i.name).join(", ")}</span>;
}

function DetailRow({ investment }: { investment: Investment }) {
  const hasThemes = Boolean(investment.themes?.length);
  const round = investment.latest_round;
  const hasCoInvestors = Boolean(investment.co_investors?.length);

  if (!investment.description && !hasThemes && !round && !hasCoInvestors) {
    return null;
  }

  return (
    <tr className="bg-gray-50/50">
      <td colSpan={8} className="px-4 py-4">
        <div className="flex flex-col gap-3 pl-[42px] text-[13px]">
          {investment.description && <p className="text-gray-600">{investment.description}</p>}
          {hasThemes && (
            <div className="flex flex-wrap items-center gap-1.5">
              {investment.themes?.map((theme) => (
                <Badge key={theme} tone="amber">
                  {theme}
                </Badge>
              ))}
            </div>
          )}
          {round && (
            <div>
              <div className="text-[12px] text-gray-400">Latest round</div>
              <div className="text-gray-700">
                {[round.date ? formatDate(new Date(round.date), "MMM yyyy") : null, round.name]
                  .filter((v): v is string => Boolean(v))
                  .join(" - ")}
              </div>
              <div className="text-gray-700">
                {[
                  round.raisedAmount
                    ? formatMoney(round.raisedAmount, { currency: round.raisedCurrency, isAbbrFormat: true, maximumFractionDigits: 2 })
                    : null,
                  round.valuationAmount
                    ? `${formatMoney(round.valuationAmount, { currency: round.valuationCurrency, isAbbrFormat: true, maximumFractionDigits: 2 })} ${round.valuationType === "PRE_MONEY" ? "Pre-money" : "Post-money"}`
                    : null,
                ]
                  .filter((v): v is string => Boolean(v))
                  .join(" at ")}
              </div>
            </div>
          )}
          {hasCoInvestors && (
            <div>
              <div className="text-[12px] text-gray-400">Co-investors</div>
              <div className="text-gray-700">
                {investment.co_investors?.map((c) => c.name).join(", ")}
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
