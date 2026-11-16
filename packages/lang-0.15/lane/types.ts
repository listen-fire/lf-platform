// What crosses between the platform and this version: plain data only, never
// an object or a class of either release. The registry
// (`@listen-fire/language-versions`) states the same shapes in the current
// release's terms, and the compiler holds this package to them where the
// registry loads it.

import type { DeploymentFacts } from './manifests';
import type { ModulePlatform } from './run_types';

export type ConnectMethod = 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only';

/** One of the team's stored credentials, as the catalog reads it. */
export interface TeamCredential {
  id: string;
  name: string;
  type: string;
  /** A module's provider credential: the module and the declared credential
   *  it fills. */
  module?: { adapterType: string; credential: string };
}

/** One of the team's saved files: what an import resolves against. */
export interface TeamFile {
  name: string;
  source: string;
  /** The file's own pin. */
  languageVersion: string;
}

/** What the platform knows of a team that a 0.15 catalog is built from. */
export interface TeamFacts extends DeploymentFacts {
  credentials: readonly TeamCredential[];
  files: readonly TeamFile[];
  /** How a credential of `credentialType` is connected on the platform. */
  connectOf(credentialType: string): ConnectMethod;
  /** The team's installs of remote adapters: each install's stored manifest
   *  file, as JSON. */
  remoteAdapters?: readonly { adapterType: string; manifest: unknown }[];
}

export interface Position {
  line: number;
  col: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export interface CheckedDiagnostic {
  code: string;
  message: string;
  /** This release's severity for the code. */
  severity: 'error' | 'warning' | 'info';
  span: Span;
  upgrade?: true;
  fix?: { edits: { span: Span; text: string }[]; safe?: true };
}

/** A connected system the check could not read, so nothing about it was
 *  checked: the program is unverified, never clean. */
export interface CheckGap {
  adapter: string;
  detail: string;
}

export interface CheckedSource {
  diagnostics: CheckedDiagnostic[];
  /** The movement each `listen` fires, in file order. */
  firedMovements: string[];
  gaps: CheckGap[];
  notes: string[];
}

/** A program checked under its pin and the team it belongs to. With
 *  `connected`, the connected systems it constructs are read through the
 *  platform's hosting of 0.15's modules; without it, each is a gap. */
export interface CheckRequest {
  source: string;
  pin: string;
  team: TeamFacts;
  connected?: { teamId: string; modules: ModulePlatform };
}

/** An editor request: `offset` is a UTF-16 offset into `source`. */
export interface EditorRequest extends CheckRequest {
  offset: number;
}
