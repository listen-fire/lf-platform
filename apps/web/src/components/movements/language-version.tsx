// The language version an automation is written in, as a person sees it: its
// name, and — when the automation is on an older version than the current one
// and something keeps it there — what that something is.

import {
  CURRENT_LANGUAGE_VERSION,
  languageVersionView,
  type LanguageVersion,
} from "movement-lang";

import { Badge } from "@/components/ui";

/** One stored diagnostic, as the api returns it. */
export interface UpgradeDiagnostic {
  message: string;
  severity: "error" | "warning" | "info";
  line: number;
  col: number;
}

function versionName(version: LanguageVersion): string {
  return languageVersionView(version).name;
}

function issuesText(count: number): string {
  return count === 1 ? "1 issue" : `${count} issues`;
}

/** The version's name, wherever it's shown: a tag, not prose. */
function VersionTag({ name }: { name: string }) {
  return <Badge tone="mono">{name}</Badge>;
}

/** The automations list's cell: the version's name, and a warning badge when
 *  something keeps the automation off the current version. */
export function LanguageVersionCell({
  languageVersion,
  upgradeDiagnostics,
}: {
  languageVersion: LanguageVersion;
  upgradeDiagnostics: UpgradeDiagnostic[] | null;
}) {
  const count = upgradeDiagnostics?.length ?? 0;
  return (
    <td className="py-3 pr-4 text-gray-500">
      <span className="flex items-center gap-1.5">
        <VersionTag name={versionName(languageVersion)} />
        {count > 0 && (
          <Badge
            tone="amber"
            testId="language-version-warning"
            title={`${issuesText(count)} keep this automation on ${versionName(languageVersion)} — open it to see them`}
          >
            Review
          </Badge>
        )}
      </span>
    </td>
  );
}

/** The automation page's note: which version it is written in and, when it
 *  is behind, what stands between it and the current one. */
export function LanguageVersionNotice({
  languageVersion,
  upgradeDiagnostics,
}: {
  languageVersion: LanguageVersion;
  upgradeDiagnostics: UpgradeDiagnostic[] | null;
}) {
  const name = versionName(languageVersion);
  const current = versionName(CURRENT_LANGUAGE_VERSION);
  const issues = upgradeDiagnostics ?? [];
  return (
    <section data-testid="language-version-notice">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
        Version
      </h2>
      <p className="text-[12.5px] leading-relaxed text-gray-600">
        Written in <VersionTag name={name} />
        {languageVersion === CURRENT_LANGUAGE_VERSION
          ? ", the current version."
          : (
            <>
              . The current version is <VersionTag name={current} />.
            </>
          )}
      </p>
      {languageVersion !== CURRENT_LANGUAGE_VERSION && issues.length === 0 && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-gray-600">
          It keeps running as <VersionTag name={name} /> until you ask your
          assistant to upgrade it.
        </p>
      )}
      {issues.length > 0 && (
        <>
          <p className="mt-2 text-[12.5px] leading-relaxed text-gray-600">
            It keeps running as <VersionTag name={name} />.{" "}
            <VersionTag name={current} /> reports the issues below; fix them,
            then ask your assistant to upgrade it.
          </p>
          <ul className="mt-2 space-y-1.5">
            {issues.map((d, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span
                  className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                    d.severity === "error" ? "bg-red-500" : "bg-amber-500"
                  }`}
                />
                <span className="min-w-0">
                  <span className="block text-[12.5px] leading-relaxed text-gray-700">
                    {d.message}
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] text-gray-400">
                    Line {d.line}, column {d.col}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
