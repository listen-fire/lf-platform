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
  /** The rewrite the checker offers: replace each 1-based range with `text`
   *  (an empty range inserts). Unless `safe`, it changes what the automation
   *  does, so its author reviews it before an upgrade applies it. */
  fix?: { edits: UpgradeEdit[]; safe?: true };
}

export interface UpgradeEdit {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

// A legacy id ('1'..'4') is a version from before the language was versioned
// by its release.
function isLegacy(version: LanguageVersion): boolean {
  return /^[1-4]$/.test(version);
}

function versionName(version: LanguageVersion): string {
  return isLegacy(version) ? `legacy ${version}` : version;
}

/** What happens to it until it is upgraded: nothing runs a legacy id, and its
 *  listens stay stopped; a release pin of an earlier line stopped firing at
 *  the deploy that installed the current version unless its version still
 *  fires its listens, and the panel says exactly what the platform still does
 *  with it when it carries that version (checking edits, running it when
 *  someone starts it, resuming its parked runs). */
function Meanwhile({ version, route }: { version: LanguageVersion; route: EditorLanguageRoute }) {
  if (isLegacy(version)) {
    return <>Nothing runs <VersionTag name={versionName(version)} />, and its listens stay stopped, until you upgrade it.</>;
  }
  const own = <VersionTag name={versionName(version)} />;
  const listens = route.provides?.listen === true;
  const stopped = listens ? null : (
    <>Its listens stopped firing when <VersionTag name={versionName(LANGUAGE_VERSION)} /> was installed, and stay stopped until you upgrade it. </>
  );
  if (route.kind !== "carried") return stopped;
  return (
    <>
      {stopped}
      Edits to it are still checked under {own}.
      {route.provides?.run === true && <> Run now and test runs run it under {own}.</>}
      {route.provides?.run === true && route.provides.resume !== true && (
        <> A run of it that would wait (an ask, a pause, a wait for an event) is stopped where it waits.</>
      )}
    </>
  );
}

function offsetOf(source: string, at: { line: number; col: number }): number {
  const lines = source.split("\n");
  const before = lines.slice(0, at.line - 1).reduce((sum, line) => sum + line.length + 1, 0);
  return Math.min(before + at.col - 1, source.length);
}

/** One edit as lines of a diff: what its range holds now (when the text is at
 *  hand) and what replaces it. */
function editLines(edit: UpgradeEdit, source: string | undefined): { removed: string[]; added: string[] } {
  const removed =
    source === undefined
      ? []
      : source.slice(offsetOf(source, edit), offsetOf(source, { line: edit.endLine, col: edit.endCol })).split("\n").filter((line) => line !== "");
  return { removed, added: edit.text.split("\n").filter((line) => line !== "") };
}

/** A fix that is not provably meaning preserving, as a diff for its author to
 *  review. Nothing here applies it: an upgrade applies it only when it is asked
 *  to apply every fix, after the author has accepted it. */
function ProposedChange({ fix, source }: { fix: NonNullable<UpgradeDiagnostic["fix"]>; source: string | undefined }) {
  return (
    <span className="mt-1.5 block" data-testid="upgrade-fix">
      <span className="block text-[11px] text-gray-500">
        Proposed change. Read it, then tell your agent to accept it when it upgrades; nothing applies it before.
      </span>
      <span className="mt-1 block overflow-x-auto rounded bg-gray-50 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
        {fix.edits.map((edit, i) => {
          const { removed, added } = editLines(edit, source);
          return (
            <span key={i} className="block">
              {removed.map((line, j) => (
                <span key={`-${j}`} className="block whitespace-pre text-red-700">- {line}</span>
              ))}
              {added.map((line, j) => (
                <span key={`+${j}`} className="block whitespace-pre text-green-700">+ {line}</span>
              ))}
            </span>
          );
        })}
      </span>
    </span>
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
  source,
}: {
  languageVersion: LanguageVersion;
  /** The server's account of the pin. */
  route: EditorLanguageRoute;
  upgradeDiagnostics: UpgradeDiagnostic[] | null;
  /** The saved text the diagnostics' positions are in, to show what a fix replaces. */
  source?: string;
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
                  {d.fix !== undefined && d.fix.safe !== true && <ProposedChange fix={d.fix} source={source} />}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
