"use client";

/**
 * Port of apps/app's Portfolio/Profile/Header.tsx — the company identity
 * block: logo, name, status badge, description, website/location links, and
 * an Edit action that opens EditHeader. The hover popover with legal
 * name/other names/id is dropped (V-20 only requires the presentation be
 * rewritten, not every affordance preserved) — legal name renders inline as
 * a subtitle instead, which is strictly more discoverable.
 */

import Link from "next/link";
import { Globe, MapPin, Pencil } from "lucide-react";

import { getCountryByCode } from "platform-constants/countries";
import { Badge } from "@/components/ui";
import { useDisclosure } from "@/components/portfolio";

import type { Company } from "./types";
import { CompanyLogo } from "./company-logo";
import { EditHeader } from "./edit-header";

function neverAsAny(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}

function getHostname(url: string): string {
  for (const candidate of [url, `https://${url}`]) {
    try {
      return new URL(candidate).hostname;
    } catch {
      // try the next candidate
    }
  }
  return url;
}

function toHref(url: string): string {
  for (const candidate of [url, `https://${url}`]) {
    try {
      return new URL(candidate).toString();
    } catch {
      // try the next candidate
    }
  }
  return url;
}

function statusConfig(status: NonNullable<Company>["status"]) {
  switch (status) {
    case "active":
      return { tone: "violet" as const, text: "active" };
    case "realised":
      return { tone: "red" as const, text: "realised" };
    default:
      return neverAsAny(status);
  }
}

export function CompanyHeader({ company }: { company: Company }) {
  const editDisclosure = useDisclosure();
  if (!company) return null;

  const badge = statusConfig(company.status);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-4">
        <CompanyLogo
          border
          alt={company.name ?? "Unknown"}
          url={company.personal_website}
          size={64}
          fetchSize={128}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-bold text-gray-900">
              {company.name ?? "Unknown"}
            </h1>
            {company.acquirer?.id ? (
              <Badge tone="emerald">Acquired</Badge>
            ) : (
              <Badge tone={badge.tone}>{badge.text}</Badge>
            )}
            <button
              type="button"
              onClick={editDisclosure.onOpen}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <Pencil size={13} />
              Edit
            </button>
          </div>

          {company.legal_name && company.legal_name !== company.name && (
            <div className="text-[12px] text-gray-400">
              {company.legal_name}
            </div>
          )}

          {company.description && (
            <p className="truncate text-[13px] text-gray-500">
              {company.description.replace(/^"|"$/g, "")}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            {company.personal_website && (
              <a
                href={toHref(company.personal_website)}
                target="_blank"
                rel="noreferrer nofollow"
                className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-700"
              >
                <Globe size={14} />
                {getHostname(company.personal_website)}
              </a>
            )}
            {company.country && (
              <div className="flex items-center gap-1.5 text-[13px] text-gray-500">
                <MapPin size={14} />
                {getCountryByCode(company.country)?.title ?? company.country}
              </div>
            )}
          </div>
        </div>
      </div>

      {company.acquirer?.id && (
        <div className="flex items-center gap-1.5 text-[13px] text-gray-600">
          Acquired by
          <Link
            href={`/portfolio/c/${company.acquirer.slug}`}
            prefetch={false}
            className="font-semibold text-gray-900 hover:underline"
          >
            {company.acquirer.name}
          </Link>
        </div>
      )}

      <EditHeader company={company} {...editDisclosure} />
    </div>
  );
}
