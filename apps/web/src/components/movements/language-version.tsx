// The language version an automation is written in, as a person sees it: the
// release it pins, and — when the pin is not on the current version and
// something keeps it there — what that something is. Whether a pin is on the
// current version is the server's answer (its `languageRoute`, from the
// platform's registry of the versions it carries), never a comparison made
// here.

import { LANGUAGE_VERSION, type LanguageVersion } from "movement-lang";

import { Badge } from "@/components/ui";

import type { EditorLanguageRoute } from "./editor-lint";

/** One stored diagnostic, as the api returns it. */
export interface UpgradeDiagnostic {
  message: string;
  severity: "error" | "warning" | "info";
  line: number;
  col: number;
}

// A legacy id ('1'..'4') is a version from before the language was versioned
// by its release.
function isLegacy(version: LanguageVersion): boolean {
  return /^[1-4]$/.test(version);
}

function versionName(version: LanguageVersion): string {
  return isLegacy(version) ? `legacy ${version}` : version;
}

/** What happens to it until it is upgraded: a legacy id runs on the platform's
 *  own engine; a release pin of an earlier line stopped firing at the deploy
 *  that installed the current version, and is still checked under its own
 *  version when the platform carries that version's checker. */
function Meanwhile({ version, route }: { version: LanguageVersion; route: EditorLanguageRoute }) {
  if (isLegacy(version)) {
    return <>It keeps running as <VersionTag name={versionName(version)} /> until you upgrade it.</>;
  }
  const stopped = (
    <>It stopped firing when <VersionTag name={versionName(LANGUAGE_VERSION)} /> was installed, and stays stopped until you upgrade it.</>
  );
  return route.kind === "carried" ? (
    <>
      {stopped} Edits to it are still checked under <VersionTag name={versionName(version)} />.
    </>
  ) : (
    stopped
  );
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
  route,
  upgradeDiagnostics,
}: {
  languageVersion: LanguageVersion;
  /** The server's account of the pin. */
  route: EditorLanguageRoute;
  upgradeDiagnostics: UpgradeDiagnostic[] | null;
}) {
  const name = versionName(languageVersion);
  const current = versionName(LANGUAGE_VERSION);
  const isCurrent = route.kind === "installed";
  const issues = upgradeDiagnostics ?? [];
  return (
    <section data-testid="language-version-notice">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
        Version
      </h2>
      <p className="text-[12.5px] leading-relaxed text-gray-600">
        Written in <VersionTag name={name} />
        {isCurrent
          ? ", the current version."
          : (
            <>
              . The current version is <VersionTag name={current} />.
            </>
          )}
      </p>
      {!isCurrent && issues.length === 0 && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-gray-600">
          <Meanwhile version={languageVersion} route={route} /> Ask your own agent to
          upgrade it, through the MCP connector.
        </p>
      )}
      {issues.length > 0 && (
        <>
          <p className="mt-2 text-[12.5px] leading-relaxed text-gray-600">
            <Meanwhile version={languageVersion} route={route} />{" "}
            <VersionTag name={current} /> reports the issues below; fix them,
            then ask your own agent to upgrade it, through the MCP connector.
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
